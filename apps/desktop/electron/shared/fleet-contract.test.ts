import { describe, expect, it } from 'vitest'
import { FleetCheckRequestSchema, FleetRequestSchema } from './contract.js'

/**
 * The fleet boundary carries script text to servers, which makes it the most
 * consequential thing the renderer can reach. These assert what it cannot
 * express.
 */

const base = {
  connectionIds: ['c1'],
  script: 'uptime',
  label: 'uptime',
}

describe('FleetRequestSchema', () => {
  it('names servers by id, never by host', () => {
    const parsed = FleetRequestSchema.parse(base)
    expect(parsed.connectionIds).toEqual(['c1'])
    // No host, user, port or key field exists here: those come from the
    // stored connection, so a renderer cannot invent a server to reach.
    expect(Object.keys(parsed)).not.toContain('host')
    expect(Object.keys(parsed)).not.toContain('username')
  })

  it('refuses a run with no servers', () => {
    expect(FleetRequestSchema.safeParse({ ...base, connectionIds: [] }).success).toBe(false)
  })

  it('refuses an empty script', () => {
    expect(FleetRequestSchema.safeParse({ ...base, script: '' }).success).toBe(false)
  })

  it('allows only the two shells and raw, not an arbitrary binary', () => {
    expect(FleetRequestSchema.safeParse({ ...base, interpreter: 'sh' }).success).toBe(true)
    expect(FleetRequestSchema.safeParse({ ...base, interpreter: 'bash' }).success).toBe(true)
    expect(FleetRequestSchema.safeParse({ ...base, interpreter: 'raw' }).success).toBe(true)
    expect(FleetRequestSchema.safeParse({ ...base, interpreter: '/usr/bin/python3' }).success).toBe(false)
    expect(FleetRequestSchema.safeParse({ ...base, interpreter: 'sh -c evil' }).success).toBe(false)
  })

  it('defaults hazardsConfirmed to false, so silence is never consent', () => {
    expect(FleetRequestSchema.parse(base).hazardsConfirmed).toBe(false)
  })

  it('defaults to a modest concurrency and caps it', () => {
    expect(FleetRequestSchema.parse(base).concurrency).toBe(4)
    expect(FleetRequestSchema.safeParse({ ...base, concurrency: 5000 }).success).toBe(false)
    expect(FleetRequestSchema.safeParse({ ...base, concurrency: 0 }).success).toBe(false)
  })

  it('bounds the timeout rather than letting a run hold a connection forever', () => {
    expect(FleetRequestSchema.parse(base).timeoutSeconds).toBe(900)
    expect(FleetRequestSchema.safeParse({ ...base, timeoutSeconds: 999999 }).success).toBe(false)
  })

  it('caps the fleet size and the script length', () => {
    const many = Array.from({ length: 501 }, (_, index) => `c${index}`)
    expect(FleetRequestSchema.safeParse({ ...base, connectionIds: many }).success).toBe(false)
    expect(FleetRequestSchema.safeParse({ ...base, script: 'x'.repeat(300 * 1024) }).success).toBe(false)
  })

  it('caps the sudo password so the field cannot be used as a data channel', () => {
    expect(FleetRequestSchema.safeParse({ ...base, sudo: true, sudoPassword: 'x'.repeat(2000) }).success).toBe(false)
    expect(FleetRequestSchema.safeParse({ ...base, sudo: true, sudoPassword: 'hunter2' }).success).toBe(true)
  })

  it('leaves the sudo password absent when none was given, rather than empty', () => {
    expect(FleetRequestSchema.parse(base).sudoPassword).toBeUndefined()
  })

  it('is not root unless it says so', () => {
    expect(FleetRequestSchema.parse(base).sudo).toBe(false)
  })

  it('continues through failures unless asked to stop', () => {
    expect(FleetRequestSchema.parse(base).onFailure).toBe('continue')
    expect(FleetRequestSchema.safeParse({ ...base, onFailure: 'panic' }).success).toBe(false)
  })
})

describe('FleetCheckRequestSchema', () => {
  it('has a short default timeout, because it only reads state', () => {
    expect(FleetCheckRequestSchema.parse({ connectionIds: ['c1'] }).timeoutSeconds).toBe(180)
  })

  it('takes no script at all: a status sweep cannot be turned into a command', () => {
    const parsed = FleetCheckRequestSchema.parse({ connectionIds: ['c1'], script: 'rm -rf /' } as never)
    expect(Object.keys(parsed)).toEqual(['connectionIds', 'concurrency', 'timeoutSeconds'])
  })
})
