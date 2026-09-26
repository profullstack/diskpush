import { describe, it, expect } from 'vitest'
import { localExecStream, isLocalConnectionId, LOCAL_CONNECTION_ID } from './local-session.js'

describe('isLocalConnectionId', () => {
  it('recognizes the reserved local id and nothing else', () => {
    expect(isLocalConnectionId(LOCAL_CONNECTION_ID)).toBe(true)
    expect(isLocalConnectionId('local')).toBe(true)
    expect(isLocalConnectionId('ssh-config:dev1')).toBe(false)
    expect(isLocalConnectionId('some-uuid')).toBe(false)
  })
})

describe('localExecStream', () => {
  it('captures stdout and a zero exit, and streams whole lines', async () => {
    const lines: string[] = []
    const handle = localExecStream("printf 'one\\ntwo\\n'", { onStdout: (l) => lines.push(l) })
    const res = await handle.finished
    expect(res.code).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.stdout).toBe('one\ntwo\n')
    expect(lines).toEqual(['one', 'two'])
  })

  it('captures a non-zero exit code', async () => {
    const res = await localExecStream('exit 3').finished
    expect(res.code).toBe(3)
  })

  it('separates stderr and streams it', async () => {
    const errs: string[] = []
    const res = await localExecStream('echo oops 1>&2', { onStderr: (l) => errs.push(l) }).finished
    expect(res.stderr).toBe('oops\n')
    expect(errs).toEqual(['oops'])
    expect(res.code).toBe(0)
  })

  it('feeds stdin to the command (as sudo -S would use)', async () => {
    const res = await localExecStream('cat', { stdin: 'secret-line\n' }).finished
    expect(res.stdout).toBe('secret-line\n')
  })

  it('enforces a timeout and marks the result timedOut', async () => {
    const res = await localExecStream('sleep 30', { timeoutSeconds: 1 }).finished
    expect(res.timedOut).toBe(true)
    expect(res.code).not.toBe(0)
  }, 15000)

  it('can be cancelled', async () => {
    const handle = localExecStream('sleep 30')
    setTimeout(() => handle.cancel(), 50)
    const res = await handle.finished
    expect(res.code).not.toBe(0)
    expect(res.timedOut).toBe(false)
  }, 15000)
})
