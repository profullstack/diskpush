import { readFile } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { probeConnection, parseSshConfig } from '@diskpush/ssh-core'
import { z } from 'zod'
import {
  ConnectionInputSchema,
  ExternalUrlSchema,
  IPC,
  JobIdSchema,
  PathSchema,
  RemotePathRequestSchema,
  RenameRequestSchema,
  TransferRequestSchema,
  type IpcResult,
} from '../shared/contract'
import { browserFor, dropSession, sessionFor } from './services/sessions'
import { store } from './services/store'
import { cancelTransfer, previewTransfer, startTransfer } from './services/transfers'

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
    const connection = await db.findConnection(id)
    if (!connection) throw new Error('That connection no longer exists.')

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
        keyPath: host.identityFile ?? null,
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
    const db = await store()
    const connection = await db.findConnection(connectionId)
    if (!connection) throw new Error('That connection no longer exists.')

    const browser = await browserFor(connection)
    try {
      return { path, entries: await browser.list(path) }
    } finally {
      browser.close()
    }
  })

  handle(IPC.fsMkdirRemote, RemotePathRequestSchema, async ({ connectionId, path }) => {
    const db = await store()
    const connection = await db.findConnection(connectionId)
    if (!connection) throw new Error('That connection no longer exists.')
    const browser = await browserFor(connection)
    try {
      await browser.mkdir(path)
      return true
    } finally {
      browser.close()
    }
  })

  handle(IPC.fsRenameRemote, RenameRequestSchema, async ({ connectionId, from, to }) => {
    const db = await store()
    const connection = await db.findConnection(connectionId)
    if (!connection) throw new Error('That connection no longer exists.')
    const browser = await browserFor(connection)
    try {
      await browser.rename(from, to)
      return true
    } finally {
      browser.close()
    }
  })

  handle(
    IPC.fsDeleteRemote,
    z.object({ connectionId: z.string().min(1), path: PathSchema, isDirectory: z.boolean() }),
    async ({ connectionId, path, isDirectory }) => {
      const db = await store()
      const connection = await db.findConnection(connectionId)
      if (!connection) throw new Error('That connection no longer exists.')
      const browser = await browserFor(connection)
      try {
        if (isDirectory) await browser.rmdir(path)
        else await browser.unlink(path)
        return true
      } finally {
        browser.close()
      }
    },
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

  // --- shell ---------------------------------------------------------------

  handle(IPC.shellOpenExternal, z.object({ url: ExternalUrlSchema }), async ({ url }) => {
    await shell.openExternal(url)
    return true
  })
}
