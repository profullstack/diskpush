import { randomUUID } from 'node:crypto'
import {
  FLEET_DEFAULT_CONCURRENCY,
  FLEET_DEFAULT_TIMEOUT_SECONDS,
  FLEET_MAX_CAPTURED_BYTES,
  type Connection,
  type FleetEvent,
  type FleetFailureMode,
  type FleetHostResult,
  type FleetHostState,
  type FleetInterpreter,
  type FleetRunState,
} from '@diskpush/schemas'
import { SshError, type ExecResult, type SshSession } from '@diskpush/ssh-core'
import { buildCommand, explainSudoFailure, withSudoPassword, type SudoMode } from './command.js'

/**
 * Running one command across many servers.
 *
 * Three properties this is built around, in order:
 *
 *  1. Every host is reported separately. There is no aggregate "success"
 *     unless every host succeeded, and a host that was never reached is not
 *     the same as a host that failed.
 *  2. Concurrency is bounded and modest by default. Forty simultaneous SSH
 *     connections is a way to get rate-limited by your own bastion.
 *  3. A run can be stopped. Hosts that have not started are cancelled; hosts
 *     already running get a signal and are given the chance to leave cleanly.
 */

/** How the caller opens a session. Injected so this is testable without a network. */
export type ConnectFn = (connection: Connection) => Promise<SshSession>

/**
 * Called once per host when its command is done with the session.
 *
 * Whether that means closing it is the caller's business: the CLI opens a
 * connection per host and wants it closed, while the desktop pools sessions
 * across browsing and transfers and would be closing a connection out from
 * under a file pane.
 */
export type ReleaseFn = (session: SshSession, connection: Connection) => void

export type FleetRunOptions = {
  connections: readonly Connection[]
  script: string
  interpreter: FleetInterpreter
  sudo: SudoMode
  /** Collected once, never stored, written only to `sudo -S` on stdin. */
  sudoPassword?: string | undefined
  workingDirectory?: string | null
  env?: Readonly<Record<string, string>>
  timeoutSeconds?: number
  concurrency?: number
  onFailure?: FleetFailureMode
  /** See `BuildOptions.failFast`. Defaults to stopping at the first failure. */
  failFast?: boolean
  connect: ConnectFn
  release?: ReleaseFn
  onEvent?: (event: FleetEvent) => void
  /** Aborts the run. Started hosts are signalled, queued hosts are cancelled. */
  signal?: AbortSignal
  /** Supplied by the caller so the run can be recorded before it starts. */
  runId?: string
}

export type FleetRunResult = {
  runId: string
  state: FleetRunState
  command: string
  results: FleetHostResult[]
  succeeded: number
  failed: number
  skipped: number
}

/**
 * Keeps the head and the tail of very chatty output.
 *
 * A full `apt upgrade` transcript across thirty servers is megabytes, and
 * nobody reads the middle. Dropping the middle rather than the tail matters:
 * the error is almost always in the last few lines.
 */
export function clampOutput(text: string, limit = FLEET_MAX_CAPTURED_BYTES): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.3)
  const tail = limit - head
  const dropped = text.length - limit
  return `${text.slice(0, head)}\n... ${dropped.toLocaleString()} bytes omitted ...\n${text.slice(-tail)}`
}

/** Exit 0 is success. Everything else is the command's own verdict, kept as-is. */
function stateFor(result: ExecResult): FleetHostState {
  if (result.timedOut) return 'timeout'
  return result.code === 0 ? 'succeeded' : 'failed'
}

function summarize(result: ExecResult, state: FleetHostState): string | null {
  if (state === 'succeeded') return null
  if (state === 'timeout') return 'The command was still running when the timeout was reached.'

  const sudoNote = explainSudoFailure(result.stderr)
  if (sudoNote) return sudoNote

  // The last non-empty stderr line is what a person would quote if asked what
  // went wrong. Falling back to stdout matters for the many tools that report
  // failures there.
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines.at(-1)
  return last ? last.slice(0, 300) : `Exited with code ${result.code}.`
}

export async function runFleet(options: FleetRunOptions): Promise<FleetRunResult> {
  const runId = options.runId ?? randomUUID()
  const timeoutSeconds = options.timeoutSeconds ?? FLEET_DEFAULT_TIMEOUT_SECONDS
  const concurrency = Math.max(1, options.concurrency ?? FLEET_DEFAULT_CONCURRENCY)
  const onFailure = options.onFailure ?? 'continue'
  const emit = options.onEvent ?? (() => {})

  const base = buildCommand({
    script: options.script,
    interpreter: options.interpreter,
    sudo: options.sudo,
    workingDirectory: options.workingDirectory ?? null,
    ...(options.env ? { env: options.env } : {}),
    ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
  })
  const built = options.sudo === 'password' && options.sudoPassword ? withSudoPassword(base, options.sudoPassword) : base

  emit({
    type: 'run-start',
    runId,
    hosts: options.connections.map((connection) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      host: connection.host,
    })),
    // `display`, not `command`: the runnable form pipes the script through
    // stdin and would show as a bare `/bin/sh -es` in every log.
    command: built.display,
  })

  const results = new Map<string, FleetHostResult>()
  for (const connection of options.connections) {
    results.set(connection.id, blankResult(runId, connection))
  }

  /**
   * Two flags, not one.
   *
   * `halted` means stop starting new hosts, and a failure under
   * `onFailure: 'stop'` sets it. `aborted` means the caller pulled the plug,
   * and only that sets it — so a host that genuinely failed while the run was
   * winding down is still reported as failed rather than relabelled cancelled.
   */
  let halted = false
  let aborted = false
  const cancels = new Set<() => void>()

  const abort = () => {
    halted = true
    aborted = true
    for (const cancel of cancels) cancel()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) {
    halted = true
    aborted = true
  }

  const queue = [...options.connections]
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const connection = queue[index]
      if (!connection) return

      if (halted) {
        results.set(connection.id, { ...results.get(connection.id)!, state: 'cancelled' })
        emit({ type: 'host-exit', connectionId: connection.id, result: results.get(connection.id)! })
        continue
      }

      const result = await runOne(connection)
      results.set(connection.id, result)
      emit({ type: 'host-exit', connectionId: connection.id, result })

      if (onFailure === 'stop' && result.state !== 'succeeded' && result.state !== 'skipped') {
        // Stop *queuing*, but let the hosts already in flight finish: killing
        // a package manager mid-transaction to enforce a policy about a
        // different server leaves a broken dpkg behind.
        halted = true
      }
    }
  }

  const runOne = async (connection: Connection): Promise<FleetHostResult> => {
    const startedAt = new Date().toISOString()
    const started = Date.now()
    emit({ type: 'host-start', connectionId: connection.id })

    let session: SshSession
    try {
      session = await options.connect(connection)
    } catch (error) {
      // Unreachable, not failed. The command never ran, so reporting it as a
      // failed command would be a lie about what state the server is in.
      return {
        ...blankResult(runId, connection),
        state: 'unreachable',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        errorSummary: error instanceof SshError ? error.message : error instanceof Error ? error.message : String(error),
      }
    }

    const handle = session.execStream(built.command, {
      timeoutSeconds,
      ...(built.stdin !== undefined ? { stdin: built.stdin } : {}),
      onStdout: (line) => emit({ type: 'host-stdout', connectionId: connection.id, line }),
      onStderr: (line) => emit({ type: 'host-stderr', connectionId: connection.id, line }),
    })
    cancels.add(handle.cancel)

    try {
      const exec = await handle.finished
      // Only a real abort turns a non-zero exit into "cancelled": the signal
      // is what killed it. A failure elsewhere in the fleet does not change
      // what happened on this host.
      const state = aborted && exec.code !== 0 && !exec.timedOut ? 'cancelled' : stateFor(exec)
      return {
        ...blankResult(runId, connection),
        state,
        exitCode: exec.timedOut ? null : exec.code,
        stdout: clampOutput(exec.stdout),
        stderr: clampOutput(exec.stderr),
        errorSummary: summarize(exec, state),
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      }
    } catch (error) {
      return {
        ...blankResult(runId, connection),
        state: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        errorSummary: error instanceof Error ? error.message : String(error),
      }
    } finally {
      cancels.delete(handle.cancel)
      options.release?.(session, connection)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
  options.signal?.removeEventListener('abort', abort)

  const all = [...results.values()]
  const succeeded = all.filter((result) => result.state === 'succeeded').length
  const failed = all.filter(
    (result) => result.state === 'failed' || result.state === 'unreachable' || result.state === 'timeout',
  ).length
  const skipped = all.filter((result) => result.state === 'cancelled' || result.state === 'skipped').length

  // A run stopped by `onFailure: 'stop'` is a *failed* run that left hosts
  // untouched, not a cancelled one. Only the caller aborting makes it
  // cancelled, and a failure outranks that either way.
  const state: FleetRunState = failed > 0 ? 'failed' : aborted || skipped > 0 ? 'cancelled' : 'completed'

  emit({ type: 'run-exit', runId, state, succeeded, failed, skipped })

  return { runId, state, command: built.display, results: all, succeeded, failed, skipped }
}

function blankResult(runId: string, connection: Connection): FleetHostResult {
  return {
    runId,
    connectionId: connection.id,
    connectionName: connection.name,
    host: connection.host,
    state: 'pending',
    exitCode: null,
    stdout: '',
    stderr: '',
    errorSummary: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }
}

export { FLEET_DEFAULT_CONCURRENCY, FLEET_DEFAULT_TIMEOUT_SECONDS }
