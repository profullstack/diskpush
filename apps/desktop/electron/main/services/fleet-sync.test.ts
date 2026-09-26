import { describe, it, expect, vi } from 'vitest'
import { FleetSyncRequestSchema } from '../../shared/contract.js'

// The transfer engine is exercised elsewhere; here we test only the fan-out
// orchestration, so buildPlan/runPlan are stubbed.
vi.mock('./transfers.js', () => ({
  buildPlan: vi.fn(async () => ({
    plan: { display: '', controlDisplay: null, warnings: [] },
    cleanup: async () => {},
  })),
}))
vi.mock('@diskpush/rsync-core', () => ({
  runPlan: vi.fn(() => ({
    events: (async function* () {
      yield { type: 'progress', progress: { percent: 50, bytesTransferred: 1, bytesPerSecond: 1, elapsedSeconds: 1 } }
      yield { type: 'exit', code: 0, resumable: false, message: '' }
    })(),
    cancel: () => {},
  })),
}))

const { startFleetSync } = await import('./fleet-sync.js')

function fakeSender() {
  const sends: Array<{ ch: string; payload: { syncId: string; connectionId: string | null; event: { type: string } } }> = []
  const sender = {
    isDestroyed: () => false,
    send: (ch: string, payload: unknown) => sends.push({ ch, payload: payload as never }),
  } as never
  return { sends, sender }
}

const req = (dests: string[]) =>
  FleetSyncRequestSchema.parse({
    source: { type: 'ssh', connectionId: 'src', path: '/data' },
    destinationConnectionIds: dests,
    destinationPath: '/data',
    options: {},
    concurrency: 2,
  })

describe('FleetSyncRequestSchema', () => {
  it('requires at least one destination', () => {
    expect(() => req([])).toThrow()
  })
  it('defaults concurrency', () => {
    const parsed = FleetSyncRequestSchema.parse({
      source: { type: 'ssh', connectionId: 'src', path: '/data' },
      destinationConnectionIds: ['a'],
      destinationPath: '/data',
      options: {},
    })
    expect(parsed.concurrency).toBe(4)
  })
})

describe('startFleetSync', () => {
  it('runs one transfer per destination, streams per-connection events, then a done marker', async () => {
    const { sends, sender } = fakeSender()
    const res = await startFleetSync(req(['a', 'b']), sender)
    expect(res.destinations).toEqual(['a', 'b'])

    // Let the async worker pool drain.
    await new Promise((r) => setTimeout(r, 30))

    for (const id of ['a', 'b']) {
      const forId = sends.filter((s) => s.payload.connectionId === id)
      expect(forId.some((s) => s.payload.event.type === 'begin'), `${id} begins`).toBe(true)
      expect(forId.some((s) => s.payload.event.type === 'exit'), `${id} exits`).toBe(true)
    }
    expect(sends.some((s) => s.payload.connectionId === null && s.payload.event.type === 'done')).toBe(true)
  })
})
