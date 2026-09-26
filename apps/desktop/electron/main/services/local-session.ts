import { spawn } from 'node:child_process'
import type { ExecHandle, ExecResult, ExecStreamOptions, SshSession } from '@diskpush/ssh-core'

/**
 * A "session" that runs a fleet command on THIS machine instead of over SSH.
 *
 * It implements the exact slice of SshSession that the fleet runner uses —
 * `execStream(command, options): ExecHandle` — so `runFleet` can target the
 * local host with no changes: the desktop's connect() hands back a LocalSession
 * for the synthetic `localhost` connection and a pooled SshSession for the rest.
 *
 * The command is the same interpreter invocation the runner builds for a remote
 * host (e.g. `sh -c '<script>'`, optionally wrapped in sudo), run through the
 * local shell — so a script that fans out to the fleet itself (an ssh loop, an
 * rsync push) runs exactly as it would if you pasted it into a terminal here.
 */
export function localExecStream(command: string, options: ExecStreamOptions = {}): ExecHandle {
  // detached so the child is its own process group leader: a script that spawns
  // its own children (an ssh loop, an rsync) can then be stopped as a group,
  // rather than leaving the real work running after the shell is signalled.
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })

  // Signal the whole group (negative pid); fall back to the bare process.
  const killTree = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false

  // Emit whole lines as they arrive; keep the trailing partial line buffered.
  const linePump = (emit?: (line: string) => void) => {
    let buf = ''
    return {
      push(chunk: string) {
        buf += chunk
        let nl = buf.indexOf('\n')
        while (nl !== -1) {
          emit?.(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
        }
      },
      flush() {
        if (buf.length > 0) emit?.(buf)
        buf = ''
      },
    }
  }
  const outPump = linePump(options.onStdout)
  const errPump = linePump(options.onStderr)

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk; outPump.push(chunk) })
  child.stderr.on('data', (chunk: string) => { stderr += chunk; errPump.push(chunk) })

  // Feed sudo -S its password (and anything else the built command reads), then
  // close stdin so a command waiting on input does not hang the whole run.
  if (options.stdin !== undefined) child.stdin.write(options.stdin)
  child.stdin.end()

  let timer: NodeJS.Timeout | undefined
  if (options.timeoutSeconds && options.timeoutSeconds > 0) {
    timer = setTimeout(() => {
      timedOut = true
      killTree('SIGKILL')
    }, options.timeoutSeconds * 1000)
  }

  const finished = new Promise<ExecResult>((resolve) => {
    const done = (code: number) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      outPump.flush()
      errPump.flush()
      resolve({ stdout, stderr, code, timedOut })
    }
    child.on('error', (err) => {
      // Could not even start the shell: report it as a non-zero exit with the
      // reason on stderr, the same shape a failed remote exec produces.
      stderr += (stderr ? '\n' : '') + (err instanceof Error ? err.message : String(err))
      done(127)
    })
    child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0)))
  })

  return {
    finished,
    cancel: () => {
      if (settled) return
      killTree('SIGINT')
      // Give it a moment to leave cleanly, then insist.
      setTimeout(() => { if (!settled) killTree('SIGKILL') }, 2000)
    },
  }
}

/** A LocalSession shaped as the fleet runner's SshSession dependency. */
export function localSession(): SshSession {
  return { execStream: localExecStream } as unknown as SshSession
}

/** The reserved id of the synthetic "this machine" fleet target. */
export const LOCAL_CONNECTION_ID = 'local'

/** True when a connection id refers to the local host rather than an SSH server. */
export function isLocalConnectionId(id: string): boolean {
  return id === LOCAL_CONNECTION_ID
}
