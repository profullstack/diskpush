import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  intersectCapabilities,
  parseRsyncCapabilities,
  planTransfer,
  runPlan,
  unknownCapabilities,
  type ExecutionPlan,
  type RsyncCapabilities,
} from '@diskpush/rsync-core'
import { defaultRsyncOptions, summarizeChanges, type Endpoint, type RsyncOptions } from '@diskpush/schemas'
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

/**
 * The most deletions a preview will send to the renderer.
 *
 * The dialog exists so a person can see what is about to be destroyed, so the
 * list is not summarised away -- but a first mirror into an empty destination
 * can propose hundreds of thousands of them, and the renderer used to build a
 * DOM node for every one. Past this point the count is still exact and still
 * on the confirm button; it is only the enumeration that stops.
 */
export const PREVIEW_DELETE_LIMIT = 5000

export type PreviewProgress = {
  /** Entries rsync has compared so far, from its own `to-chk` counter. */
  checked: number
  /**
   * Entries rsync currently knows about. It grows during the scan, because
   * rsync builds the file list incrementally, so this is a moving target and
   * never a promise.
   */
  total: number
  /** Changes seen so far, and the deletions among them. */
  changes: number
  deletes: number
  currentPath: string
  elapsedSeconds: number
}

export type PreviewResult = {
  summary: ReturnType<typeof summarizeChanges>
  /** Capped at PREVIEW_DELETE_LIMIT; `deleteTotal` is the real number. */
  deletes: string[]
  deleteTotal: number
  /** Every change rsync reported, deletions included. */
  changeTotal: number
  command: string
  control: string | null
  warnings: string[]
  ok: boolean
  message: string
  /** True when the user stopped the scan rather than it finishing. */
  cancelled: boolean
}

type RunningPreview = { cancel: () => void; cancelled: boolean }
const previews = new Map<string, RunningPreview>()

/** How often scan progress is pushed to the renderer, at most. */
const PREVIEW_TICK_MS = 120

/**
 * The dry run behind Preview Changes and behind every mirror.
 *
 * Three things it deliberately does not do, each of which it used to.
 *
 * It does not accumulate every change. A dry run of an ordinary source tree
 * emits a few hundred thousand of them; keeping the array and returning it
 * meant ~70MB crossing the IPC boundary by structured clone, for a field the
 * renderer never read. Only the counts and the capped delete list survive.
 *
 * It does not run silently. Progress is streamed as it goes, so the dialog can
 * show what is being compared instead of a spinner that is indistinguishable
 * from a hang.
 *
 * It does not run unstoppably. The handle is registered under `previewId`, so
 * Cancel kills the rsync process rather than only hiding the dialog and
 * leaving the scan to finish into nothing.
 */
export async function previewTransfer(
  request: TransferRequest & { previewId: string },
  sender: WebContents,
): Promise<PreviewResult> {
  const plan = await buildPlan(request, { dryRun: true })

  const summary = summarizeChanges([])
  const deletes: string[] = []
  let deleteTotal = 0
  let changeTotal = 0
  let checked = 0
  let total = 0
  let currentPath = ''
  const startedAt = Date.now()

  const handle = runPlan(plan)
  const entry: RunningPreview = { cancel: handle.cancel, cancelled: false }
  previews.set(request.previewId, entry)

  let lastTick = 0
  const emit = (force: boolean) => {
    const now = Date.now()
    if (!force && now - lastTick < PREVIEW_TICK_MS) return
    lastTick = now
    if (sender.isDestroyed()) return
    sender.send(IPC.eventPreview, {
      previewId: request.previewId,
      progress: {
        checked,
        total,
        changes: changeTotal,
        deletes: deleteTotal,
        currentPath,
        elapsedSeconds: Math.round((now - startedAt) / 1000),
      } satisfies PreviewProgress,
    })
  }

  // Sent before rsync has said anything, so the dialog starts with a scan it
  // can see rather than with an empty panel it has to explain.
  emit(true)

  let ok = false
  let message = ''

  try {
    for await (const event of handle.events) {
      switch (event.type) {
        case 'change': {
          changeTotal += 1
          summary[event.change.action] += 1
          currentPath = event.change.path
          if (event.change.action === 'delete') {
            deleteTotal += 1
            if (deletes.length < PREVIEW_DELETE_LIMIT) deletes.push(event.change.path)
          }
          emit(false)
          break
        }
        case 'progress': {
          // rsync counts down: `to-chk=remaining/total`.
          if (event.progress.filesTotal !== null) {
            total = event.progress.filesTotal
            checked = event.progress.filesTotal - (event.progress.filesRemaining ?? 0)
          }
          emit(false)
          break
        }
        case 'exit': {
          ok = event.code === 0 || event.code === 24
          message = event.message
          break
        }
        default:
          break
      }
    }
  } finally {
    previews.delete(request.previewId)
  }

  emit(true)

  return {
    summary,
    deletes,
    deleteTotal,
    changeTotal,
    command: plan.display,
    control: plan.controlDisplay ?? null,
    warnings: plan.warnings,
    // A scan the user stopped is not a scan that failed, and it must never be
    // reported as one: `ok` gates the confirm button, and a cancelled preview
    // has not established that anything is safe to delete.
    ok: entry.cancelled ? false : ok,
    message: entry.cancelled ? 'Scan cancelled.' : message,
    cancelled: entry.cancelled,
  }
}

/** Stops a dry run that is still scanning. False when it already finished. */
export function cancelPreview(previewId: string): boolean {
  const entry = previews.get(previewId)
  if (!entry) return false
  entry.cancelled = true
  entry.cancel()
  return true
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
  sourcePane: 'left' | 'right'
}) {
  const source = await resolveEndpoint(input.source)
  const destination = await resolveEndpoint(input.destination)
  return (await store()).saveProfile({
    name: input.name,
    source: source.endpoint,
    destination: destination.endpoint,
    preset: 'fast-sync',
    options: optionsFrom(input.options),
    sourcePane: input.sourcePane,
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
