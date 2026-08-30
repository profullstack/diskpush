import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { expandTilde, probeConnection, parseSshConfig, sshConfigConnections, type SftpBrowser } from '@diskpush/ssh-core'
import { z } from 'zod'
import {
  ConnectionInputSchema,
  CreateEntryRequestSchema,
  DeleteEntryRequestSchema,
  ExternalUrlSchema,
  FleetCheckRequestSchema,
  FleetCommandSaveSchema,
  FleetListRenameSchema,
  FleetListSaveSchema,
  FleetRequestSchema,
  FleetRunIdSchema,
  IPC,
  JobIdSchema,
  PathSchema,
  RemotePathRequestSchema,
  RenameEntryRequestSchema,
  TransferRequestSchema,
  type IpcResult,
} from '../shared/contract.js'
import { requireConnection } from './services/connections.js'
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
import { browserFor, dropSession, sessionFor } from './services/sessions.js'
import { store } from './services/store.js'
import { cancelTransfer, previewTransfer, startTransfer } from './services/transfers.js'

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
async function withBrowser<T>(connectionId: string | undefined, fn: (browser: SftpBrowser) => Promise<T>): Promise<T> {
  if (!connectionId) throw new Error('That operation needs a server.')
  const browser = await browserFor(await requireConnection(connectionId))
  try {
    return await fn(browser)
  } finally {
    browser.close()
  }
}

export function registerIpc(): void {
  // --- connections ---------------------------------------------------------

  handle(IPC.connectionsList, z.undefined(), async () => (await store()).listConnections())

  handle(IPC.connectionsSave, ConnectionInputSchema, async (input) => {
    const db = await store()
    const saved = await db.saveConnection(input)
    // Settings may have changed under an open session; drop it so the next
    // use reconnects with the new values rather than the stale ones.
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
      await db.saveConnection({
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

    const browser = await browserFor(connection)
    try {
      return { path, entries: await browser.list(path) }
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

  // --- transfers -----------------------------------------------------------

  handle(IPC.transfersPreview, TransferRequestSchema, async (request) => previewTransfer(request))

  handle(IPC.transfersStart, TransferRequestSchema, async (request, event) => startTransfer(request, event.sender))

  handle(IPC.transfersCancel, z.object({ jobId: JobIdSchema }), async ({ jobId }) => cancelTransfer(jobId))

  handle(IPC.transfersList, z.object({ limit: z.number().int().min(1).max(500).default(50) }), async ({ limit }) =>
    (await store()).listJobs(limit),
  )

  // --- profiles ------------------------------------------------------------

  handle(IPC.profilesList, z.undefined(), async () => (await store()).listProfiles())

  handle(IPC.profilesRemove, z.object({ id: z.string().min(1) }), async ({ id }) => (await store()).deleteProfile(id))

  // --- fleet ---------------------------------------------------------------

  handle(IPC.fleetServers, z.undefined(), async () => fleetServers())

  handle(IPC.fleetCommands, z.undefined(), async () => fleetCommands())

  handle(IPC.fleetPreview, FleetRequestSchema, async (request) => previewFleet(request))

  handle(IPC.fleetStart, FleetRequestSchema, async (request, event) => startFleet(request, event.sender))

  handle(IPC.fleetCancel, z.object({ runId: FleetRunIdSchema }), async ({ runId }) => cancelFleet(runId))

  handle(IPC.fleetCheck, FleetCheckRequestSchema, async (input) => checkFleetServers(input))

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

  // --- shell ---------------------------------------------------------------

  handle(IPC.shellOpenExternal, z.object({ url: ExternalUrlSchema }), async ({ url }) => {
    await shell.openExternal(url)
    return true
  })
}
