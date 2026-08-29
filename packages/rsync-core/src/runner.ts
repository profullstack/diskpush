import { spawn } from 'node:child_process'
import type { RsyncEvent, RsyncStats } from '@diskpush/schemas'
import { humanizeStderr, interpretExit } from './errors.js'
import { emptyStats, parseItemizeLine, parseProgressLine, parseStatsLine, splitOutputLines } from './parse.js'
import type { ExecutionPlan } from './plan.js'

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export type RsyncRunHandle = {
  events: AsyncIterable<RsyncEvent>
  /** Stops the transfer, leaving partial data in place so it can resume. */
  cancel(): void
}

/**
 * Runs a plan and streams structured events.
 *
 * The process is always spawned with `shell: false`. For a server-to-server
 * plan the binary is `ssh` and the rsync argv travels as one pre-quoted
 * argument; nothing on this side is re-interpreted.
 */
export function runPlan(plan: ExecutionPlan, options: RunOptions = {}): RsyncRunHandle {
  const queue: RsyncEvent[] = []
  const waiters: Array<(value: IteratorResult<RsyncEvent>) => void> = []
  let finished = false

  const push = (event: RsyncEvent) => {
    const waiter = waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else queue.push(event)
  }
  const finish = () => {
    finished = true
    while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true })
  }

  const spawnOptions: Parameters<typeof spawn>[2] = { shell: false, windowsHide: true }
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd
  if (options.env !== undefined) spawnOptions.env = options.env

  const child = spawn(plan.binary, plan.args, spawnOptions)

  push({ type: 'start', command: plan.binary, args: plan.args })

  const stats: RsyncStats = emptyStats()
  let stdoutRest = ''
  let stderrRest = ''
  const stderrLines: string[] = []

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    const { lines, rest } = splitOutputLines(stdoutRest + chunk)
    stdoutRest = rest
    for (const line of lines) handleStdout(line)
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    const { lines, rest } = splitOutputLines(stderrRest + chunk)
    stderrRest = rest
    for (const line of lines) {
      if (line.trim() === '') continue
      stderrLines.push(line)
      push({ type: 'stderr', line })
    }
  })

  function handleStdout(line: string) {
    if (line.trim() === '') return

    const progress = parseProgressLine(line)
    if (progress) {
      push({ type: 'progress', progress })
      return
    }
    const change = parseItemizeLine(line)
    if (change) {
      push({ type: 'change', change })
      return
    }
    if (parseStatsLine(line, stats)) return
    push({ type: 'stdout', line })
  }

  const cancel = () => {
    // SIGINT, not SIGKILL: rsync cleans up and leaves the partial file behind.
    if (!child.killed) child.kill('SIGINT')
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  child.on('error', (error) => {
    const message =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `DiskPush could not find ${plan.binary} on this computer.`
        : error.message
    push({ type: 'stderr', line: message })
    push({ type: 'exit', code: -1, signal: null, resumable: false, message })
    finish()
  })

  child.on('close', (code, signal) => {
    if (stdoutRest.trim() !== '') handleStdout(stdoutRest)
    if (stderrRest.trim() !== '') {
      stderrLines.push(stderrRest)
      push({ type: 'stderr', line: stderrRest })
    }
    if (stats.filesTotal !== null || stats.totalBytesSent !== null || stats.speedup !== null) {
      push({ type: 'stats', stats })
    }

    const interpretation = interpretExit(code ?? -1, signal)
    const humanized = humanizeStderr(stderrLines.join('\n'))
    push({
      type: 'exit',
      code: code ?? -1,
      signal,
      resumable: interpretation.resumable,
      message: humanized ?? interpretation.message,
    })
    finish()
  })

  const events: AsyncIterable<RsyncEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<RsyncEvent>> {
          const queued = queue.shift()
          if (queued) return Promise.resolve({ value: queued, done: false })
          if (finished) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
        return(): Promise<IteratorResult<RsyncEvent>> {
          cancel()
          return Promise.resolve({ value: undefined as never, done: true })
        },
      }
    },
  }

  return { events, cancel }
}

export type RunSummary = {
  exitCode: number
  ok: boolean
  resumable: boolean
  message: string
  changes: import('@diskpush/schemas').Change[]
  lastProgress: import('@diskpush/schemas').RsyncProgress | null
  stats: RsyncStats | null
  stderr: string[]
}

/** Drains a run to completion. Used by dry runs and by the non-interactive CLI. */
export async function runToCompletion(
  plan: ExecutionPlan,
  options: RunOptions = {},
  onEvent?: (event: RsyncEvent) => void,
): Promise<RunSummary> {
  const summary: RunSummary = {
    exitCode: -1,
    ok: false,
    resumable: false,
    message: '',
    changes: [],
    lastProgress: null,
    stats: null,
    stderr: [],
  }

  const handle = runPlan(plan, options)
  for await (const event of handle.events) {
    onEvent?.(event)
    switch (event.type) {
      case 'change':
        summary.changes.push(event.change)
        break
      case 'progress':
        summary.lastProgress = event.progress
        break
      case 'stats':
        summary.stats = event.stats
        break
      case 'stderr':
        summary.stderr.push(event.line)
        break
      case 'exit':
        summary.exitCode = event.code
        summary.resumable = event.resumable
        summary.message = event.message
        summary.ok = interpretExit(event.code, event.signal).ok
        break
      default:
        break
    }
  }
  return summary
}
