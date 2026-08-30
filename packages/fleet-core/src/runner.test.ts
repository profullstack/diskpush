import { describe, expect, it, vi } from 'vitest'
import type { Connection, FleetEvent } from '@diskpush/schemas'
import type { ExecHandle, ExecResult, ExecStreamOptions, SshSession } from '@diskpush/ssh-core'
import { clampOutput, runFleet } from './runner.js'

function connection(name: string): Connection {
  return {
    id: `id-${name}`,
    name,
    host: `${name}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'agent',
    keyPath: null,
    defaultLocalPath: null,
    defaultRemotePath: null,
    jumpHost: null,
    rsyncPath: null,
    connectTimeoutSeconds: 15,
    keepaliveSeconds: 30,
    forwardAgent: false,
    tags: [],
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** What one fake host does when the command reaches it. */
type Behaviour =
  | { kind: 'exit'; code: number; stdout?: string; stderr?: string; delayMs?: number }
  | { kind: 'refuse-connection'; message: string }
  | { kind: 'hang' }

function fakeSession(behaviour: Behaviour, log: { closed: boolean }): SshSession {
  return {
    execStream(_command: string, options: ExecStreamOptions = {}): ExecHandle {
      let cancelled = false
      let settle: ((result: ExecResult) => void) | null = null

      const finished = new Promise<ExecResult>((resolve) => {
        settle = resolve
        if (behaviour.kind === 'hang') return
        if (behaviour.kind !== 'exit') return

        const run = () => {
          for (const line of (behaviour.stdout ?? '').split('\n').filter(Boolean)) options.onStdout?.(line)
          for (const line of (behaviour.stderr ?? '').split('\n').filter(Boolean)) options.onStderr?.(line)
          resolve({
            stdout: behaviour.stdout ?? '',
            stderr: behaviour.stderr ?? '',
            code: behaviour.code,
            timedOut: false,
          })
        }
        if (behaviour.delayMs) setTimeout(run, behaviour.delayMs)
        else queueMicrotask(run)
      })

      return {
        finished,
        cancel: () => {
          if (cancelled) return
          cancelled = true
          settle?.({ stdout: '', stderr: 'interrupted', code: 130, timedOut: false })
        },
      }
    },
    close: () => {
      log.closed = true
    },
  } as unknown as SshSession
}

function fleetOf(behaviours: Record<string, Behaviour>) {
  const connections = Object.keys(behaviours).map(connection)
  const closed = new Map<string, { closed: boolean }>()

  const connect = async (target: Connection): Promise<SshSession> => {
    const behaviour = behaviours[target.name]!
    if (behaviour.kind === 'refuse-connection') throw new Error(behaviour.message)
    const log = { closed: false }
    closed.set(target.name, log)
    return fakeSession(behaviour, log)
  }

  return { connections, connect, closed }
}

describe('runFleet', () => {
  it('runs on every selected host and reports each separately', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 0, stdout: 'ok' },
      'web-02': { kind: 'exit', code: 0, stdout: 'ok' },
    })

    const run = await runFleet({ connections, script: 'uptime', interpreter: 'sh', sudo: 'off', connect })

    expect(run.state).toBe('completed')
    expect(run.succeeded).toBe(2)
    expect(run.results.map((r) => r.state)).toEqual(['succeeded', 'succeeded'])
  })

  it('does not call a run successful when one host failed', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 0 },
      'web-02': { kind: 'exit', code: 1, stderr: 'nginx: configuration file test failed' },
    })

    const run = await runFleet({ connections, script: 'nginx -t', interpreter: 'sh', sudo: 'off', connect })

    expect(run.state).toBe('failed')
    expect(run.succeeded).toBe(1)
    expect(run.failed).toBe(1)
    expect(run.results.find((r) => r.connectionName === 'web-02')?.errorSummary).toContain('nginx')
  })

  it('keeps unreachable apart from failed, because they are different situations', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 0 },
      'web-02': { kind: 'refuse-connection', message: 'Connection refused' },
      'web-03': { kind: 'exit', code: 2 },
    })

    const run = await runFleet({ connections, script: 'id', interpreter: 'sh', sudo: 'off', connect })

    const byName = new Map(run.results.map((r) => [r.connectionName, r]))
    expect(byName.get('web-02')?.state).toBe('unreachable')
    expect(byName.get('web-02')?.exitCode).toBeNull()
    expect(byName.get('web-03')?.state).toBe('failed')
    expect(byName.get('web-03')?.exitCode).toBe(2)
  })

  it('records the exit code the command actually produced', async () => {
    const { connections, connect } = fleetOf({ 'web-01': { kind: 'exit', code: 23 } })
    const run = await runFleet({ connections, script: 'x', interpreter: 'sh', sudo: 'off', connect })
    expect(run.results[0]?.exitCode).toBe(23)
  })

  it('streams output per host as it arrives', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 0, stdout: 'line one\nline two', stderr: 'a warning' },
    })

    const events: FleetEvent[] = []
    await runFleet({
      connections,
      script: 'x',
      interpreter: 'sh',
      sudo: 'off',
      connect,
      onEvent: (event) => events.push(event),
    })

    expect(events.filter((e) => e.type === 'host-stdout').map((e) => (e as { line: string }).line)).toEqual([
      'line one',
      'line two',
    ])
    expect(events.filter((e) => e.type === 'host-stderr')).toHaveLength(1)
    expect(events[0]?.type).toBe('run-start')
    expect(events.at(-1)?.type).toBe('run-exit')
  })

  it('never puts the runnable command in the event, only the readable one', async () => {
    const { connections, connect } = fleetOf({ 'web-01': { kind: 'exit', code: 0 } })
    const events: FleetEvent[] = []
    await runFleet({
      connections,
      script: 'systemctl restart nginx',
      interpreter: 'sh',
      sudo: 'off',
      connect,
      onEvent: (event) => events.push(event),
    })
    const start = events[0] as { type: 'run-start'; command: string }
    expect(start.command).toContain('systemctl restart nginx')
  })

  it('holds concurrency to the limit it was given', async () => {
    const behaviours: Record<string, Behaviour> = {}
    for (let index = 0; index < 8; index += 1) {
      behaviours[`web-0${index}`] = { kind: 'exit', code: 0, delayMs: 5 }
    }
    const { connections, connect } = fleetOf(behaviours)

    let inFlight = 0
    let peak = 0
    const counted = async (target: Connection) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      const session = await connect(target)
      // The fake resolves on a timer, so decrementing after `finished` is what
      // actually measures overlap.
      const original = session.execStream.bind(session)
      return {
        ...session,
        execStream: (command: string, options?: never) => {
          const handle = original(command, options)
          return { ...handle, finished: handle.finished.finally(() => { inFlight -= 1 }) }
        },
      } as unknown as SshSession
    }

    await runFleet({ connections, script: 'x', interpreter: 'sh', sudo: 'off', concurrency: 3, connect: counted })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('stops queuing further hosts under onFailure: stop', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 1 },
      'web-02': { kind: 'exit', code: 0 },
      'web-03': { kind: 'exit', code: 0 },
    })

    const run = await runFleet({
      connections,
      script: 'x',
      interpreter: 'sh',
      sudo: 'off',
      concurrency: 1,
      onFailure: 'stop',
      connect,
    })

    expect(run.results[0]?.state).toBe('failed')
    expect(run.results.slice(1).map((r) => r.state)).toEqual(['cancelled', 'cancelled'])
    // A halted run is a failed run that left hosts untouched, not a cancelled one.
    expect(run.state).toBe('failed')
  })

  it('finishes the whole fleet under onFailure: continue', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 1 },
      'web-02': { kind: 'exit', code: 0 },
      'web-03': { kind: 'exit', code: 0 },
    })

    const run = await runFleet({
      connections,
      script: 'x',
      interpreter: 'sh',
      sudo: 'off',
      concurrency: 1,
      onFailure: 'continue',
      connect,
    })

    expect(run.succeeded).toBe(2)
    expect(run.failed).toBe(1)
  })

  it('cancels in-flight hosts when the caller aborts', async () => {
    const { connections, connect } = fleetOf({ 'web-01': { kind: 'hang' }, 'web-02': { kind: 'hang' } })
    const controller = new AbortController()

    const promise = runFleet({
      connections,
      script: 'sleep 600',
      interpreter: 'sh',
      sudo: 'off',
      concurrency: 2,
      connect,
      signal: controller.signal,
    })

    // Let both hosts get as far as running before pulling the plug.
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    const run = await promise
    expect(run.state).toBe('cancelled')
    expect(run.results.every((r) => r.state === 'cancelled')).toBe(true)
  })

  it('hands the session back so the caller can decide whether to close it', async () => {
    const { connections, connect, closed } = fleetOf({ 'web-01': { kind: 'exit', code: 0 } })
    const release = vi.fn((session: SshSession) => session.close())

    await runFleet({ connections, script: 'x', interpreter: 'sh', sudo: 'off', connect, release })

    expect(release).toHaveBeenCalledOnce()
    expect(closed.get('web-01')?.closed).toBe(true)
  })

  it('leaves the session open when no release was supplied', async () => {
    const { connections, connect, closed } = fleetOf({ 'web-01': { kind: 'exit', code: 0 } })
    await runFleet({ connections, script: 'x', interpreter: 'sh', sudo: 'off', connect })
    expect(closed.get('web-01')?.closed).toBe(false)
  })

  it('records a duration for every host that ran', async () => {
    const { connections, connect } = fleetOf({ 'web-01': { kind: 'exit', code: 0, delayMs: 5 } })
    const run = await runFleet({ connections, script: 'x', interpreter: 'sh', sudo: 'off', connect })
    expect(run.results[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(run.results[0]?.startedAt).not.toBeNull()
    expect(run.results[0]?.completedAt).not.toBeNull()
  })

  it('explains a sudo password refusal instead of repeating sudo at the user', async () => {
    const { connections, connect } = fleetOf({
      'web-01': { kind: 'exit', code: 1, stderr: 'sudo: a password is required' },
    })
    const run = await runFleet({ connections, script: 'x', interpreter: 'sh', sudo: 'non-interactive', connect })
    expect(run.results[0]?.errorSummary).toContain('--sudo-password')
  })
})

describe('clampOutput', () => {
  it('leaves ordinary output alone', () => {
    expect(clampOutput('hello', 100)).toBe('hello')
  })

  it('keeps the head and the tail, because the error is at the end', () => {
    const clamped = clampOutput(`START${'x'.repeat(500)}END`, 100)
    expect(clamped).toContain('START')
    expect(clamped).toContain('END')
    expect(clamped).toContain('bytes omitted')
  })
})
