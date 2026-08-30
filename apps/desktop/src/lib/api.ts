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
  /** Where a symlink points, when the server could tell us. */
  linkTarget?: string
  /** What it points at. Absent on a broken link, which is why it is optional. */
  targetType?: 'file' | 'directory' | 'symlink' | 'other'
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
  /** Optional because the two-pane view predates them and never asked for them. */
  tags?: string[]
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

/** A saved source/destination pair with its options. Runnable from the CLI too. */
export type SyncProfile = {
  id: string
  name: string
  source: { type: 'local'; path: string } | { type: 'ssh'; connectionId?: string; host: string; path: string }
  destination: { type: 'local'; path: string } | { type: 'ssh'; connectionId?: string; host: string; path: string }
  options: { deleteMode: 'off' | 'delay' | 'during' | 'after' | 'before' }
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

export type FleetHostState =
  | 'pending'
  | 'connecting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'skipped'

export type FleetHostResult = {
  runId: string
  connectionId: string
  connectionName: string
  host: string
  state: FleetHostState
  exitCode: number | null
  stdout: string
  stderr: string
  errorSummary: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
}

export type FleetCommand = {
  id: string
  name: string
  description: string
  script: string
  interpreter: 'sh' | 'bash' | 'raw'
  sudo: boolean
  workingDirectory: string | null
  timeoutSeconds: number
  concurrency: number
  onFailure: 'continue' | 'stop'
  targets: string[]
  tags: string[]
  builtin: boolean
}

/** Everything a saved command remembers. The servers are chosen at run time. */
export type FleetCommandSave = {
  name: string
  description?: string
  script: string
  interpreter: 'sh' | 'bash' | 'raw'
  sudo: boolean
  workingDirectory: string | null
  timeoutSeconds: number
  concurrency: number
  onFailure: 'continue' | 'stop'
  targets?: string[]
}

export type Hazard = { kind: string; explanation: string; line: string; lineNumber: number }

export type FleetListMember = { connectionId: string; connectionName: string }

/** A saved set of servers. Members carry the name each had when it was saved. */
export type FleetList = {
  id: string
  name: string
  description: string
  members: FleetListMember[]
  createdAt: string
  updatedAt: string
}

export type FleetPreview = {
  servers: { id: string; name: string; host: string }[]
  hazards: Hazard[]
  command: string
}

export type HostUpdateReport = {
  connectionId: string
  connectionName: string
  host: string
  reachable: boolean
  packageManager: string
  os: string | null
  kernel: string | null
  uptimeSeconds: number | null
  updates: number | null
  securityUpdates: number | null
  rebootRequired: boolean | null
  diskUsedPercent: number | null
  error: string | null
}

export type FleetEvent =
  | { type: 'run-start'; runId: string; hosts: { connectionId: string }[]; command: string }
  | { type: 'host-start'; connectionId: string }
  | { type: 'host-stdout'; connectionId: string; line: string }
  | { type: 'host-stderr'; connectionId: string; line: string }
  | { type: 'host-exit'; connectionId: string; result: FleetHostResult }
  | { type: 'run-exit'; runId: string; state: string; succeeded: number; failed: number; skipped: number }
  /** Only the main process emits this: the run never got as far as a host. */
  | { type: 'run-error'; message: string }

export type FleetRequest = {
  connectionIds: string[]
  script: string
  interpreter: 'sh' | 'bash' | 'raw'
  sudo: boolean
  sudoPassword?: string
  workingDirectory: string | null
  timeoutSeconds: number
  concurrency: number
  onFailure: 'continue' | 'stop'
  hazardsConfirmed: boolean
  commandId: string | null
  label: string
}

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
    /**
     * The mutating operations. `connectionId` is what picks local or remote:
     * omitted means this computer, so a caller cannot forget which side it is
     * acting on the way two parallel method names invite.
     */
    mkdir(directory: string, name: string, connectionId?: string): Promise<IpcResult<boolean>>
    createFile(directory: string, name: string, connectionId?: string): Promise<IpcResult<boolean>>
    rename(directory: string, from: string, to: string, connectionId?: string): Promise<IpcResult<boolean>>
    remove(directory: string, name: string, isDirectory: boolean, connectionId?: string): Promise<IpcResult<boolean>>
  }
  transfers: {
    preview(request: unknown): Promise<IpcResult<PreviewResult>>
    start(request: unknown): Promise<IpcResult<StartedJob>>
    cancel(jobId: string): Promise<IpcResult<boolean>>
    list(limit?: number): Promise<IpcResult<unknown[]>>
  }
  profiles: {
    list(): Promise<IpcResult<SyncProfile[]>>
    save(input: {
      name: string
      source: unknown
      destination: unknown
      options: { deleteMode: 'off' | 'delay' }
    }): Promise<IpcResult<SyncProfile>>
    remove(id: string): Promise<IpcResult<boolean>>
  }
  fleet: {
    servers(): Promise<IpcResult<Connection[]>>
    commands(): Promise<IpcResult<FleetCommand[]>>
    preview(request: FleetRequest): Promise<IpcResult<FleetPreview>>
    start(request: FleetRequest): Promise<IpcResult<{ runId: string; hosts: { connectionId: string }[] }>>
    cancel(runId: string): Promise<IpcResult<boolean>>
    check(connectionIds: string[], concurrency?: number, timeoutSeconds?: number): Promise<IpcResult<HostUpdateReport[]>>
    runs(limit?: number): Promise<IpcResult<unknown[]>>
    runDetail(runId: string): Promise<IpcResult<{ run: unknown; hosts: FleetHostResult[] } | null>>
    saveCommand(input: FleetCommandSave): Promise<IpcResult<FleetCommand>>
    removeCommand(name: string): Promise<IpcResult<boolean>>
    lists(): Promise<IpcResult<FleetList[]>>
    saveList(name: string, connectionIds: string[], description?: string): Promise<IpcResult<FleetList>>
    renameList(from: string, to: string): Promise<IpcResult<FleetList>>
    removeList(name: string): Promise<IpcResult<boolean>>
  }
  shell: { openExternal(url: string): Promise<IpcResult<boolean>> }
  events: {
    onTransfer(listener: (payload: { jobId: string; event: TransferEvent }) => void): () => void
    onFleet(listener: (payload: { runId: string; event: FleetEvent }) => void): () => void
  }
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
