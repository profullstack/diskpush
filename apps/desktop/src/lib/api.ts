'use client'

/**
 * The typed view of what `preload` exposed.
 *
 * Everything returns a result envelope; `unwrap` turns a failure into a thrown
 * Error so callers can use ordinary try/catch instead of checking a flag on
 * every call.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export type FileEntry = {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: string
  mode: number
}

export type Connection = {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: string
  defaultRemotePath: string | null
  defaultLocalPath: string | null
}

export type Change = {
  action: 'add' | 'update' | 'metadata' | 'delete' | 'unchanged' | 'error'
  path: string
  itemize: string | null
  isDirectory: boolean
}

export type PreviewResult = {
  changes: Change[]
  summary: Record<Change['action'], number>
  deletes: string[]
  command: string
  control: string | null
  warnings: string[]
  ok: boolean
  message: string
}

export type StartedJob = { jobId: string; command: string; control: string | null; warnings: string[] }

export type TransferProgress = {
  bytesTransferred: number
  percent: number
  bytesPerSecond: number
  elapsedSeconds: number
}

export type TransferEvent =
  | { type: 'start'; command: string; args: string[] }
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'change'; change: Change }
  | { type: 'stderr' | 'stdout'; line: string }
  | { type: 'exit'; code: number; resumable: boolean; message: string }

type Api = {
  connections: {
    list(): Promise<IpcResult<Connection[]>>
    save(input: unknown): Promise<IpcResult<Connection>>
    remove(id: string): Promise<IpcResult<boolean>>
    test(id: string): Promise<IpcResult<unknown>>
    importSshConfig(path?: string): Promise<IpcResult<string[]>>
    sshConfigHosts(): Promise<IpcResult<Connection[]>>
  }
  fs: {
    homeLocal(): Promise<IpcResult<string>>
    listLocal(path: string): Promise<IpcResult<{ path: string; entries: FileEntry[] }>>
    listRemote(connectionId: string, path: string): Promise<IpcResult<{ path: string; entries: FileEntry[] }>>
    mkdirRemote(connectionId: string, path: string): Promise<IpcResult<boolean>>
    renameRemote(connectionId: string, from: string, to: string): Promise<IpcResult<boolean>>
    deleteRemote(connectionId: string, path: string, isDirectory: boolean): Promise<IpcResult<boolean>>
  }
  transfers: {
    preview(request: unknown): Promise<IpcResult<PreviewResult>>
    start(request: unknown): Promise<IpcResult<StartedJob>>
    cancel(jobId: string): Promise<IpcResult<boolean>>
    list(limit?: number): Promise<IpcResult<unknown[]>>
  }
  profiles: { list(): Promise<IpcResult<unknown[]>>; remove(id: string): Promise<IpcResult<boolean>> }
  shell: { openExternal(url: string): Promise<IpcResult<boolean>> }
  events: { onTransfer(listener: (payload: { jobId: string; event: TransferEvent }) => void): () => void }
}

declare global {
  interface Window {
    diskpush?: Api
  }
}

/** Null when the renderer is opened in a plain browser rather than in Electron. */
export function api(): Api | null {
  return typeof window === 'undefined' ? null : (window.diskpush ?? null)
}

export async function unwrap<T>(promise: Promise<IpcResult<T>> | undefined): Promise<T> {
  if (!promise) throw new Error('DiskPush is not running inside its desktop shell.')
  const result = await promise
  if (!result.ok) throw new Error(result.error)
  return result.data
}
