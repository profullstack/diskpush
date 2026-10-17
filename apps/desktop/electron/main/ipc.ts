import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { expandTilde, probeConnection, parseSshConfig, sshConfigConnections } from '@diskpush/ssh-core'
import { isS3Connection, type S3Connection } from '@diskpush/schemas'
import { z } from 'zod'
import {
  ConnectionInputSchema,
  CreateEntryRequestSchema,
  DeleteEntryRequestSchema,
  ExternalUrlSchema,
  FleetCheckRequestSchema,
  FleetSyncRequestSchema,
  FleetSyncIdSchema,
  FleetCommandSaveSchema,
  FleetListRenameSchema,
  FleetListSaveSchema,
  FleetRequestSchema,
  FleetRunIdSchema,
  IPC,
  JobIdSchema,
  OpenSeriesRequestSchema,
  OpenWithRequestSchema,
  PluginActionRequestSchema,
  PluginIdSchema,
  PluginSelectionSchema,
  PluginSettingsSetSchema,
  PluginTaskRequestSchema,
  PreviewRequestSchema,
  PathSchema,
  RemotePathRequestSchema,
  ProfileSaveSchema,
  RenameEntryRequestSchema,
  TransferRequestSchema,
  type IpcResult,
} from '../shared/contract.js'
import { forRenderer, requireConnection, saveConnectionInput } from './services/connections.js'
import { bucketPath, s3ClientForConnection } from './services/s3.js'
import {
  cancelFleet,
  checkFleetServers,
  fleetCommands,
  fleetLists,
  fleetRunDetail,
  removeFleetCommand,
  saveFleetCommand,
  fleetServers,
  removeFleetList,
  renameFleetList,
  saveFleetList,
  previewFleet,
  startFleet,
} from './services/fleet.js'
import { startFleetSync, cancelFleetSync } from './services/fleet-sync.js'
import { browserFor, dropSession, sessionFor, type RemoteBrowser } from './services/sessions.js'
import { store } from './services/store.js'
import { advanceSeries, handlersFor, openSeries, openWith, stopSeries } from './services/open-with.js'
import { cancelPreview, cancelTransfer, previewTransfer, saveProfile, startTransfer } from './services/transfers.js'
import {
  cancelPlugin,
  getPluginSettings,
  listPlugins,
  pluginActionsFor,
  runPluginAction,
  runPluginTask,
  setPluginEnabled,
  setPluginSettings,
} from './services/plugins.js'

/**
 * Every handler validates its input with Zod before doing anything, and every
 * handler returns a result envelope rather than throwing across the boundary,
 * so an error reaches the renderer as a message instead of a stack trace.
 */
function handle<S extends z.ZodTypeAny, R>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>, event: IpcMainInvokeEvent) => Promise<R>,
): void {
  ipcMain.handle(channel, async (event, raw): Promise<IpcResult<R>> => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { ok: false, error: issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Invalid input.' }
    }
    try {
      return { ok: true, data: await fn(parsed.data, event) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** `~` is expanded here, in the main process, rather than trusted from the renderer. */
function resolveLocalPath(input: string): string {
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/** Whether a path exists, without making the caller catch ENOENT. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Runs `fn` against an SFTP browser for `connectionId` and always closes it.
 *
 * Every remote mutation had its own copy of this, and a `finally` that is
 * written six times is a `finally` that eventually is not.
 */
async function withBrowser<T>(connectionId: string | undefined, fn: (browser: RemoteBrowser) => Promise<T>): Promise<T> {
  if (!connectionId) throw new Error('That operation needs a server.')
  const browser = await browserFor(await requireConnection(connectionId))
  try {
    return await fn(browser)
  } finally {
    browser.close()
  }
}

/** What connections:test returns for a bucket. The renderer tells it from an SSH probe by `kind`. */
export type S3TestReport = { kind: 's3'; ok: true; bucket: string; endpoint: string; message: string }

async function testS3Connection(connection: S3Connection): Promise<S3TestReport> {
  const client = await s3ClientForConnection(connection)
  const endpoint = connection.s3.endpoint ?? `AWS S3 (${connection.s3.region})`
  const seconds = connection.connectTimeoutSeconds
  try {
    await client.checkBucket(AbortSignal.timeout(seconds * 1000))
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`No answer from ${endpoint} within ${seconds}s.`)
    }
    // An S3Error's message is already the service's own explanation
    // (NoSuchBucket, AccessDenied, SignatureDoesNotMatch …).
    throw error
  }
  return {
    kind: 's3',
    ok: true,
    bucket: connection.s3.bucket,
    endpoint,
    message: `S3 bucket reachable: ${connection.s3.bucket} at ${endpoint}`,
  }
}

export function registerIpc(): void {
  // --- connections ---------------------------------------------------------

  handle(IPC.connectionsList, z.undefined(), async () =>
    Promise.all((await (await store()).listConnections()).map(forRenderer)),
  )

  handle(IPC.connectionsSave, ConnectionInputSchema, async (input) => {
    // The S3 secret, when sent, is written to the store's secret rows here and
    // is not part of what comes back: the result carries `hasSecret` only.
    const saved = await saveConnectionInput(input)
    // Settings may have changed under an open session (or a cached S3 client);
    // drop it so the next use reconnects with the new values.
    dropSession(saved.id)
    return saved
  })

  handle(IPC.connectionsRemove, z.object({ id: z.string().min(1) }), async ({ id }) => {
    dropSession(id)
    return (await store()).deleteConnection(id)
  })

  handle(IPC.connectionsTest, z.object({ id: z.string().min(1) }), async ({ id }) => {
    const db = await store()
    const connection = await requireConnection(id)

    // A bucket has no shell, no SFTP and no rsync to probe. Listing one key is
    // the test: it proves the endpoint answers, the credentials sign, and the
    // bucket exists. Nothing is cached under `capabilities:`, which describes
    // a remote rsync and would be meaningless here.
    if (isS3Connection(connection)) return testS3Connection(connection)

    const session = await sessionFor(connection)
    const report = await probeConnection(session, connection.rsyncPath)
    // Cached so transfers can gate options on what this server actually
    // supports rather than on the local rsync's feature set.
    await db.setSetting(`capabilities:${connection.id}`, report.capabilities)
    return report
  })

  handle(IPC.connectionsImport, z.object({ path: PathSchema.optional() }), async ({ path }) => {
    const target = path ? resolveLocalPath(path) : join(homedir(), '.ssh', 'config')
    const hosts = parseSshConfig(await readFile(target, 'utf8')).filter((host) => host.hostName || host.user)
    const db = await store()
    const imported: string[] = []

    for (const host of hosts) {
      // An ssh_config alias never replaces a saved bucket of the same name (and orphans its secret).
      if ((await db.findConnection(host.alias))?.kind === 's3') continue
      await db.saveConnection({
        kind: 'ssh',
        s3: null,
        name: host.alias,
        host: host.hostName ?? host.alias,
        port: host.port ?? 22,
        username: host.user ?? process.env.USER ?? 'root',
        authType: host.identityFile ? 'key' : 'agent',
        // Expanded on the way in, so a stored key path is always usable.
        keyPath: host.identityFile ? expandTilde(host.identityFile) : null,
        defaultLocalPath: null,
        defaultRemotePath: null,
        jumpHost: host.proxyJump ?? null,
        rsyncPath: null,
        connectTimeoutSeconds: 15,
        keepaliveSeconds: host.serverAliveInterval ?? 30,
        forwardAgent: false,
        tags: ['imported'],
        notes: `Imported from ${target}`,
      })
      imported.push(host.alias)
    }
    return imported
  })

  /**
   * Hosts from ~/.ssh/config, offered alongside saved connections.
   *
   * Read-only and never persisted: the picker shows them so a machine that
   * already has its servers in ssh_config needs no re-entry, and saving one is
   * a separate, deliberate act through connections:save.
   */
  handle(IPC.connectionsSshConfig, z.undefined(), async () => {
    const db = await store()
    const savedNames = new Set((await db.listConnections()).map((connection) => connection.name))
    return sshConfigConnections().filter((connection) => !savedNames.has(connection.name))
  })

  // --- browsing ------------------------------------------------------------

  handle(IPC.fsHomeLocal, z.undefined(), async () => homedir())

  handle(IPC.fsListLocal, z.object({ path: PathSchema }), async ({ path }) => {
    const directory = resolveLocalPath(path)
    const names = await readdir(directory)
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const stats = await stat(join(directory, name))
          return {
            name,
            path: join(directory, name),
            type: stats.isDirectory() ? ('directory' as const) : ('file' as const),
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            mode: stats.mode & 0o7777,
          }
        } catch {
          // A broken symlink or a file removed mid-listing is not a reason to
          // fail the whole directory.
          return null
        }
      }),
    )
    return { path: directory, entries: entries.filter((entry) => entry !== null) }
  })

  handle(IPC.fsListRemote, RemotePathRequestSchema, async ({ connectionId, path }) => {
    const connection = await requireConnection(connectionId)
    // A bucket has no home directory: `.` is its root, and the pane shows `/`.
    const directory = isS3Connection(connection) ? bucketPath(path) : path

    const browser = await browserFor(connection)
    try {
      return { path: directory, entries: await browser.list(directory) }
    } finally {
      browser.close()
    }
  })

  /**
   * The mutating operations, local and remote.
   *
   * Each takes a directory and a bare entry name and joins them here, so the
   * renderer names a thing inside the folder it is showing rather than handing
   * the main process a path to act on. `resolveLocalPath` still expands `~`,
   * but it is applied to the directory only.
   */
  handle(IPC.fsMkdirLocal, CreateEntryRequestSchema, async ({ directory, name }) => {
    await mkdir(join(resolveLocalPath(directory), name))
    return true
  })

  handle(IPC.fsCreateFileLocal, CreateEntryRequestSchema, async ({ directory, name }) => {
    // `wx` fails when the file exists rather than truncating it.
    const handle = await open(join(resolveLocalPath(directory), name), 'wx')
    await handle.close()
    return true
  })

  handle(IPC.fsRenameLocal, RenameEntryRequestSchema, async ({ directory, from, to }) => {
    const root = resolveLocalPath(directory)
    const target = join(root, to)
    // Renaming onto an existing name silently destroys it, so refuse. There is
    // an unavoidable race here; it narrows a footgun rather than closing it.
    if (await exists(target)) throw new Error(`“${to}” already exists here.`)
    await rename(join(root, from), target)
    return true
  })

  handle(IPC.fsDeleteLocal, DeleteEntryRequestSchema, async ({ directory, name, isDirectory }) => {
    const target = join(resolveLocalPath(directory), name)
    const stats = await lstat(target)
    // A symlink to a directory reports as a directory to the caller; deleting
    // it must still unlink the link rather than recurse into what it points at.
    if (stats.isSymbolicLink()) {
      await unlink(target)
      return true
    }
    if (stats.isDirectory() !== isDirectory) throw new Error('That item changed on disk; refresh and try again.')
    if (isDirectory) await rm(target, { recursive: true })
    else await unlink(target)
    return true
  })

  handle(IPC.fsMkdirRemote, CreateEntryRequestSchema, async ({ connectionId, directory, name }) =>
    withBrowser(connectionId, async (browser) => {
      await browser.mkdir(posix.join(directory, name))
      return true
    }),
  )

  handle(IPC.fsCreateFileRemote, CreateEntryRequestSchema, async ({ connectionId, directory, name }) =>
    withBrowser(connectionId, async (browser) => {
      await browser.createFile(posix.join(directory, name))
      return true
    }),
  )

  handle(IPC.fsRenameRemote, RenameEntryRequestSchema, async ({ connectionId, directory, from, to }) =>
    withBrowser(connectionId, async (browser) => {
      await browser.rename(posix.join(directory, from), posix.join(directory, to))
      return true
    }),
  )

  handle(IPC.fsDeleteRemote, DeleteEntryRequestSchema, async ({ connectionId, directory, name, isDirectory }) =>
    withBrowser(connectionId, async (browser) => {
      const target = posix.join(directory, name)
      const stats = await browser.stat(target)
      if (stats.type === 'symlink') {
        await browser.unlink(target)
        return true
      }
      if ((stats.type === 'directory') !== isDirectory) {
        throw new Error('That item changed on the server; refresh and try again.')
      }
      if (isDirectory) await browser.removeRecursive(target)
      else await browser.unlink(target)
      return true
    }),
  )

  // --- open with -----------------------------------------------------------
  // Local only. A pane pointed at a server has no path this machine can open,
  // and the renderer disables the item there rather than sending a remote one.

  handle(IPC.fsHandlers, z.object({ paths: z.array(PathSchema).min(1).max(500) }), async ({ paths }) =>
    handlersFor(paths.map(resolveLocalPath)),
  )

  handle(IPC.fsOpenWith, OpenWithRequestSchema, async ({ paths, handlerId }) => {
    await openWith(paths.map(resolveLocalPath), handlerId)
    return true
  })

  handle(IPC.fsOpenSeries, OpenSeriesRequestSchema, async ({ seriesId, paths, handlerId }, event) => {
    // Not awaited: the run outlives the call by design, and reports over
    // eventOpenSeries as it goes.
    void openSeries(seriesId, paths.map(resolveLocalPath), handlerId, event.sender)
    return true
  })

  handle(IPC.fsOpenSeriesAdvance, z.object({ seriesId: JobIdSchema }), async ({ seriesId }) => advanceSeries(seriesId))

  handle(IPC.fsOpenSeriesStop, z.object({ seriesId: JobIdSchema }), async ({ seriesId }) => stopSeries(seriesId))

  // --- transfers -----------------------------------------------------------

  handle(IPC.transfersPreview, PreviewRequestSchema, async (request, event) => previewTransfer(request, event.sender))

  handle(IPC.transfersPreviewCancel, z.object({ previewId: JobIdSchema }), async ({ previewId }) =>
    cancelPreview(previewId),
  )

  handle(IPC.transfersStart, TransferRequestSchema, async (request, event) => startTransfer(request, event.sender))

  handle(IPC.transfersCancel, z.object({ jobId: JobIdSchema }), async ({ jobId }) => cancelTransfer(jobId))

  handle(IPC.transfersList, z.object({ limit: z.number().int().min(1).max(500).default(50) }), async ({ limit }) =>
    (await store()).listJobs(limit),
  )

  // --- profiles ------------------------------------------------------------

  handle(IPC.profilesList, z.undefined(), async () => (await store()).listProfiles())

  handle(IPC.profilesSave, ProfileSaveSchema, async (input) => saveProfile(input))

  handle(IPC.profilesRemove, z.object({ id: z.string().min(1) }), async ({ id }) => (await store()).deleteProfile(id))

  // --- fleet ---------------------------------------------------------------

  handle(IPC.fleetServers, z.undefined(), async () => fleetServers())

  handle(IPC.fleetCommands, z.undefined(), async () => fleetCommands())

  handle(IPC.fleetPreview, FleetRequestSchema, async (request) => previewFleet(request))

  handle(IPC.fleetStart, FleetRequestSchema, async (request, event) => startFleet(request, event.sender))

  handle(IPC.fleetCancel, z.object({ runId: FleetRunIdSchema }), async ({ runId }) => cancelFleet(runId))

  handle(IPC.fleetCheck, FleetCheckRequestSchema, async (input) => checkFleetServers(input))

  handle(IPC.fleetSync, FleetSyncRequestSchema, async (request, event) => startFleetSync(request, event.sender))

  handle(IPC.fleetSyncCancel, z.object({ syncId: FleetSyncIdSchema }), async ({ syncId }) => cancelFleetSync(syncId))

  handle(IPC.fleetRuns, z.object({ limit: z.number().int().min(1).max(200).default(25) }), async ({ limit }) =>
    (await store()).listFleetRuns(limit),
  )

  handle(IPC.fleetRunDetail, z.object({ runId: FleetRunIdSchema }), async ({ runId }) => fleetRunDetail(runId))

  handle(IPC.fleetCommandSave, FleetCommandSaveSchema, async (input) => saveFleetCommand(input))

  handle(IPC.fleetCommandRemove, z.object({ name: z.string().min(1).max(128) }), async ({ name }) =>
    removeFleetCommand(name),
  )

  handle(IPC.fleetLists, z.undefined(), async () => fleetLists())

  handle(IPC.fleetListSave, FleetListSaveSchema, async (input) => saveFleetList(input))

  handle(IPC.fleetListRename, FleetListRenameSchema, async ({ from, to }) => renameFleetList(from, to))

  handle(IPC.fleetListRemove, z.object({ name: z.string().min(1).max(128) }), async ({ name }) =>
    removeFleetList(name),
  )

  // --- plugins -------------------------------------------------------------
  // Plugin code runs here, in the main process. The renderer names a plugin
  // and an action by id, and the files by a local directory and bare names.

  handle(IPC.pluginsList, z.undefined(), async () => listPlugins())

  handle(IPC.pluginsActionsFor, PluginSelectionSchema, async (input) => pluginActionsFor(input))

  handle(IPC.pluginsRunAction, PluginActionRequestSchema, async (request, event) => runPluginAction(request, event.sender))

  handle(IPC.pluginsRunTask, PluginTaskRequestSchema, async (request, event) => runPluginTask(request, event.sender))

  handle(IPC.pluginsCancel, z.object({ jobId: JobIdSchema }), async ({ jobId }) => cancelPlugin(jobId))

  handle(IPC.pluginsGetSettings, z.object({ pluginId: PluginIdSchema }), async ({ pluginId }) => getPluginSettings(pluginId))

  handle(IPC.pluginsSetSettings, PluginSettingsSetSchema, async ({ pluginId, values }) => setPluginSettings(pluginId, values))

  handle(IPC.pluginsSetEnabled, z.object({ pluginId: PluginIdSchema, enabled: z.boolean() }), async ({ pluginId, enabled }) =>
    setPluginEnabled(pluginId, enabled),
  )

  // --- shell ---------------------------------------------------------------

  handle(IPC.shellOpenExternal, z.object({ url: ExternalUrlSchema }), async ({ url }) => {
    await shell.openExternal(url)
    return true
  })
}
