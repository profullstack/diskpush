import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  intersectCapabilities,
  parseRsyncCapabilities,
  planTransfer,
  runPlan,
  runToCompletion,
  unknownCapabilities,
  type ExecutionPlan,
  type RsyncCapabilities,
} from '@diskpush/rsync-core'
import { defaultRsyncOptions, summarizeChanges, type Change, type Endpoint, type RsyncOptions } from '@diskpush/schemas'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IPC, type EndpointRef, type TransferOptions, type TransferRequest } from '../../shared/contract.js'
import { requireConnection, resolveConnection } from './connections.js'
import { store } from './store.js'

const execFileAsync = promisify(execFile)

export type RunningJob = { id: string; cancel: () => void }
const running = new Map<string, RunningJob>()

/**
 * Turns the renderer's endpoint reference into a real endpoint.
 *
 * The renderer names a saved connection by id; the host, user, port, key and
 * jump host are looked up here. A renderer cannot invent a host to connect to.
 */
async function resolveEndpoint(ref: EndpointRef): Promise<{ endpoint: Endpoint; connectionId: string | null }> {
  if (ref.type === 'local') return { endpoint: { type: 'local', path: ref.path }, connectionId: null }

  const connection = await requireConnection(ref.connectionId)

  return {
    endpoint: {
      type: 'ssh',
      connectionId: connection.id,
      host: connection.host,
      user: connection.username,
      port: connection.port,
      path: ref.path,
    },
    connectionId: connection.id,
  }
}

async function shellOptionsFor(connectionId: string | null) {
  if (!connectionId) return {}
  const connection = await resolveConnection(connectionId)
  if (!connection) return {}
  return {
    keyPath: connection.authType === 'key' || connection.authType === 'key-passphrase' ? connection.keyPath : null,
    jumpHost: connection.jumpHost,
    forwardAgent: connection.forwardAgent,
    connectTimeoutSeconds: connection.connectTimeoutSeconds,
  }
}

async function localCapabilities(): Promise<RsyncCapabilities> {
  try {
    const { stdout } = await execFileAsync('rsync', ['--version'])
    return parseRsyncCapabilities(stdout)
  } catch {
    return unknownCapabilities()
  }
}

async function capabilitiesFor(ids: readonly (string | null)[]): Promise<RsyncCapabilities> {
  const db = await store()
  let capabilities = await localCapabilities()
  for (const id of ids) {
    if (!id) continue
    const cached = await db.getSetting<RsyncCapabilities | null>(`capabilities:${id}`, null)
    if (cached) capabilities = intersectCapabilities(capabilities, cached)
  }
  return capabilities
}

function optionsFrom(input: TransferOptions): RsyncOptions {
  // Built from the engine's defaults and then narrowed by what the renderer
  // asked for. rawArgs stays empty: the renderer has no way to supply them.
  return defaultRsyncOptions({
    archive: input.archive,
    checksum: input.checksum,
    compression: input.compression,
    deleteMode: input.deleteMode,
    hardLinks: input.hardLinks,
    acls: input.acls,
    xattrs: input.xattrs,
    numericIds: input.numericIds,
    update: input.update,
    ignoreExisting: input.ignoreExisting,
    existingOnly: input.existingOnly,
    inplace: input.inplace,
    excludes: input.excludes,
    includes: input.includes,
    bwlimit: input.bwlimit,
    maxSize: input.maxSize,
    minSize: input.minSize,
  })
}

async function buildPlan(request: TransferRequest, overrides: Partial<RsyncOptions> = {}): Promise<ExecutionPlan> {
  const source = await resolveEndpoint(request.source)
  const destination = await resolveEndpoint(request.destination)
  const capabilities = await capabilitiesFor([source.connectionId, destination.connectionId])
  const options = { ...optionsFrom(request.options), ...overrides }

  const isServerToServer = source.endpoint.type === 'ssh' && destination.endpoint.type === 'ssh'
  const sourceConnection = source.connectionId ? await resolveConnection(source.connectionId) : null

  return planTransfer({
    source: source.endpoint,
    destination: destination.endpoint,
    options,
    capabilities,
    deletesConfirmed: request.deletesConfirmed,
    ...(isServerToServer
      ? {
          sourceShell: await shellOptionsFor(source.connectionId),
          destinationShell: await shellOptionsFor(destination.connectionId),
          sourceRsyncPath: sourceConnection?.rsyncPath ?? null,
        }
      : {
          remoteShell: await shellOptionsFor(source.connectionId ?? destination.connectionId),
        }),
  })
}

export type PreviewResult = {
  changes: Change[]
  summary: ReturnType<typeof summarizeChanges>
  deletes: string[]
  command: string
  control: string | null
  warnings: string[]
  ok: boolean
  message: string
}

/** The dry run behind Preview Changes and behind every mirror. */
export async function previewTransfer(request: TransferRequest): Promise<PreviewResult> {
  const plan = await buildPlan(request, { dryRun: true })
  const result = await runToCompletion(plan)
  return {
    changes: result.changes,
    summary: summarizeChanges(result.changes),
    deletes: result.changes.filter((change) => change.action === 'delete').map((change) => change.path),
    command: plan.display,
    control: plan.controlDisplay ?? null,
    warnings: plan.warnings,
    ok: result.ok,
    message: result.message,
  }
}

export type StartedJob = { jobId: string; command: string; control: string | null; warnings: string[] }

export async function startTransfer(request: TransferRequest, sender: WebContents): Promise<StartedJob> {
  const plan = await buildPlan(request)
  const jobId = randomUUID()
  const db = await store()

  const source = await resolveEndpoint(request.source)
  const destination = await resolveEndpoint(request.destination)

  await db.createJob({
    id: jobId,
    profileId: null,
    source: source.endpoint,
    destination: destination.endpoint,
    options: optionsFrom(request.options),
    state: 'running',
    bytesTotal: 0,
    bytesTransferred: 0,
    percent: 0,
    filesTransferred: 0,
    retryCount: 0,
    exitCode: null,
    errorSummary: null,
    logPath: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  })

  const handle = runPlan(plan)
  running.set(jobId, { id: jobId, cancel: handle.cancel })

  void (async () => {
    let percent = 0
    let bytes = 0
    let files = 0
    const stderr: string[] = []

    for await (const event of handle.events) {
      if (event.type === 'progress') {
        percent = event.progress.percent
        bytes = event.progress.bytesTransferred
      }
      if (event.type === 'change' && (event.change.action === 'add' || event.change.action === 'update')) files += 1
      if (event.type === 'stderr') stderr.push(event.line)

      // The window can go away mid-transfer; the job carries on regardless and
      // its outcome is still recorded.
      if (!sender.isDestroyed()) sender.send(IPC.eventTransfer, { jobId, event })

      if (event.type === 'exit') {
        const ok = event.code === 0 || event.code === 24
        await db.updateJob(jobId, {
          state: ok ? 'completed' : event.resumable ? 'interrupted' : 'failed',
          exitCode: event.code,
          percent: ok ? 100 : percent,
          bytesTransferred: bytes,
          filesTransferred: files,
          errorSummary: ok ? null : event.message,
          completedAt: new Date().toISOString(),
        })
        if (stderr.length > 0) await db.appendEvent(jobId, 'stderr', stderr.join('\n'))
      }
    }
    running.delete(jobId)
  })()

  return { jobId, command: plan.display, control: plan.controlDisplay ?? null, warnings: plan.warnings }
}

/**
 * Saves the current pair and options as a named profile.
 *
 * The endpoint references are resolved to full endpoints here, so the profile
 * that lands in the store is the same shape the CLI writes and can be run with
 * `diskpush profile run NAME`. One store, one profile, either surface.
 */
export async function saveProfile(input: {
  name: string
  source: EndpointRef
  destination: EndpointRef
  options: TransferOptions
}) {
  const source = await resolveEndpoint(input.source)
  const destination = await resolveEndpoint(input.destination)
  return (await store()).saveProfile({
    name: input.name,
    source: source.endpoint,
    destination: destination.endpoint,
    preset: 'fast-sync',
    options: optionsFrom(input.options),
    // Never set from the app. Unattended mirroring is the one way a delete
    // list runs without a human looking at it, and it stays a deliberate,
    // out-of-band choice.
    trustDeletes: false,
    schedule: { enabled: false, kind: 'daily', cron: null },
    watch: { enabled: false, debounceMs: 1000 },
    notifyOnSuccess: false,
    notifyOnFailure: true,
  })
}

export function cancelTransfer(jobId: string): boolean {
  const job = running.get(jobId)
  if (!job) return false
  // SIGINT, so rsync leaves its partial file behind and the job can resume.
  job.cancel()
  return true
}

/** True while any transfer is in flight; the updater defers a restart on it. */
export function hasActiveTransfer(): boolean {
  return running.size > 0
}

export function cancelAll(): void {
  for (const job of running.values()) job.cancel()
}
