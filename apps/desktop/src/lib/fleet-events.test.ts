import { describe, expect, it } from 'vitest'
import type { FleetEvent, FleetHostResult } from '@/lib/api'
import { blankHost, foldHosts, MAX_LIVE_LINES, type HostView } from './fleet-events'

const hosts: HostView[] = [
  blankHost({ id: 'a', name: 'web-01', host: 'web-01.example.com' }),
  blankHost({ id: 'b', name: 'web-02', host: 'web-02.example.com' }),
]

function exitResult(overrides: Partial<FleetHostResult> = {}): FleetHostResult {
  return {
    runId: 'r1',
    connectionId: 'a',
    connectionName: 'web-01',
    host: 'web-01.example.com',
    state: 'succeeded',
    exitCode: 0,
    stdout: '',
    stderr: '',
    errorSummary: null,
    startedAt: null,
    completedAt: null,
    durationMs: 1200,
    ...overrides,
  }
}

describe('blankHost', () => {
  it('starts every server waiting, with nothing claimed about it', () => {
    const host = blankHost({ id: 'a', name: 'web-01', host: 'h' })
    expect(host.state).toBe('pending')
    expect(host.exitCode).toBeNull()
    expect(host.errorSummary).toBeNull()
    expect(host.lines).toEqual([])
  })
})

describe('foldHosts', () => {
  it('marks only the host that started', () => {
    const next = foldHosts(hosts, { type: 'host-start', connectionId: 'a' })
    expect(next[0]?.state).toBe('running')
    expect(next[1]?.state).toBe('pending')
  })

  it('appends output to the host it came from and no other', () => {
    let next = foldHosts(hosts, { type: 'host-stdout', connectionId: 'a', line: 'one' })
    next = foldHosts(next, { type: 'host-stderr', connectionId: 'a', line: 'two' })
    next = foldHosts(next, { type: 'host-stdout', connectionId: 'b', line: 'other' })

    expect(next[0]?.lines).toEqual(['one', 'two'])
    expect(next[1]?.lines).toEqual(['other'])
  })

  it('keeps the newest lines when a host is very chatty', () => {
    let next = hosts
    for (let index = 0; index < MAX_LIVE_LINES + 50; index += 1) {
      next = foldHosts(next, { type: 'host-stdout', connectionId: 'a', line: `line ${index}` })
    }
    expect(next[0]?.lines).toHaveLength(MAX_LIVE_LINES)
    // The reason a host failed is at the end, so that is the end that is kept.
    expect(next[0]?.lines.at(-1)).toBe(`line ${MAX_LIVE_LINES + 49}`)
    expect(next[0]?.lines[0]).toBe('line 50')
  })

  it('records the outcome a host reported, including its exit code', () => {
    const next = foldHosts(hosts, {
      type: 'host-exit',
      connectionId: 'a',
      result: exitResult({ state: 'failed', exitCode: 42, errorSummary: 'nginx: test failed' }),
    })
    expect(next[0]).toMatchObject({ state: 'failed', exitCode: 42, errorSummary: 'nginx: test failed', durationMs: 1200 })
  })

  it('keeps unreachable distinct from failed', () => {
    const next = foldHosts(hosts, {
      type: 'host-exit',
      connectionId: 'a',
      result: exitResult({ state: 'unreachable', exitCode: null, errorSummary: 'Connection refused' }),
    })
    expect(next[0]?.state).toBe('unreachable')
    expect(next[0]?.exitCode).toBeNull()
  })

  it('leaves the host list alone for run-level events', () => {
    const events: FleetEvent[] = [
      { type: 'run-start', runId: 'r1', hosts: [{ connectionId: 'a' }], command: 'x' },
      { type: 'run-exit', runId: 'r1', state: 'completed', succeeded: 1, failed: 0, skipped: 0 },
      { type: 'run-error', message: 'boom' },
    ]
    for (const event of events) {
      expect(foldHosts(hosts, event)).toEqual(hosts)
    }
  })

  it('ignores an event for a host it is not showing', () => {
    expect(foldHosts(hosts, { type: 'host-start', connectionId: 'unknown' })).toEqual(hosts)
  })

  it('does not mutate the list it was given', () => {
    const next = foldHosts(hosts, { type: 'host-stdout', connectionId: 'a', line: 'one' })
    expect(hosts[0]?.lines).toEqual([])
    expect(next).not.toBe(hosts)
  })
})
