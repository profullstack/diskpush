import { describe, expect, it } from 'vitest'
import { humanizeStderr, interpretExit } from './errors.js'

describe('interpretExit', () => {
  it('reports success', () => {
    expect(interpretExit(0)).toMatchObject({ ok: true, resumable: false })
  })

  it('treats vanished source files as success', () => {
    expect(interpretExit(24).ok).toBe(true)
  })

  it('marks a dropped connection resumable rather than failed', () => {
    expect(interpretExit(12)).toMatchObject({ ok: false, resumable: true })
    expect(interpretExit(30).resumable).toBe(true)
    expect(interpretExit(23).resumable).toBe(true)
  })

  it('marks a file I/O error resumable, since the partial file survives', () => {
    expect(interpretExit(11).resumable).toBe(true)
  })

  it('does not claim a usage error is resumable', () => {
    expect(interpretExit(1).resumable).toBe(false)
  })

  it('reports a signal as resumable', () => {
    expect(interpretExit(null as unknown as number, 'SIGINT')).toMatchObject({ resumable: true })
  })

  it('does not invent a message for an unknown code', () => {
    expect(interpretExit(99).message).toMatch(/unexpected code 99/)
  })
})

describe('humanizeStderr', () => {
  it('recognises a full disk', () => {
    expect(humanizeStderr('rsync: write failed: No space left on device (28)')).toMatch(/out of space/i)
  })

  it('recognises a missing remote rsync however the shell words it', () => {
    expect(humanizeStderr('bash: rsync: command not found')).toMatch(/not installed on the remote server/i)
    expect(humanizeStderr('sh: 1: rsync: not found')).toMatch(/not installed on the remote server/i)
    expect(humanizeStderr('bash: line 1: rsync: command not found')).toMatch(/not installed on the remote server/i)
  })

  it('recognises a changed host key', () => {
    expect(humanizeStderr('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@')).toMatch(/host key/i)
  })

  it('recognises a rejected key', () => {
    expect(humanizeStderr('Permission denied (publickey,password).')).toMatch(/authentication was rejected/i)
  })

  it('returns null when it has nothing better to say', () => {
    expect(humanizeStderr('some unrecognised failure')).toBeNull()
  })
})
