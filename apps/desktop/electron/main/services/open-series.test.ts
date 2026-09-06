import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const applications = mkdtempSync(join(tmpdir(), 'diskpush-apps-'))
process.env.XDG_DATA_HOME = join(applications, 'home')
process.env.XDG_DATA_DIRS = applications
const appsDir = join(applications, 'applications')
mkdirSync(appsDir, { recursive: true })

/**
 * A fake "player": a script that ignores its argument and takes `seconds`.
 *
 * It has to be a script rather than `Exec=sleep 1`, because gio appends the
 * file to the Exec line and `sleep 1 /tmp/a.mkv` dies instantly with "invalid
 * time interval" -- which the code then correctly reads as a hand-off, so the
 * naive fixture tests the opposite of what it looks like it tests.
 */
function fakeApp(name: string, seconds: number) {
  const script = join(applications, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\n`, { mode: 0o755 })
  writeFileSync(
    join(appsDir, name),
    `[Desktop Entry]\nType=Application\nName=${name}\nExec=${script}\nTerminal=false\n`,
  )
}

// Comfortably above HANDOFF_MS, so it reads as somebody using the file.
fakeApp('slow.desktop', 2)
fakeApp('instant.desktop', 0)

const { openSeries, advanceSeries, stopSeries } = await import('./open-with.js')

type Event = { type: string; index?: number; total?: number; handedOff?: boolean; opened?: number; stopped?: boolean }

function collector() {
  const events: Event[] = []
  return {
    events,
    sender: {
      isDestroyed: () => false,
      send: (_channel: string, payload: { event: Event }) => events.push(payload.event),
    } as never,
  }
}

const until = async (condition: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never held')
}

describe('openSeries', () => {
  /*
   * The mechanism this rests on, measured rather than assumed: `gio launch`
   * returns in ~17ms, but the application it starts inherits the stdio pipes,
   * so the PIPES close when the application ends (~3018ms for a 3s app).
   * Waiting on the pipes is what makes "opens the next when you finish" work
   * without reimplementing the desktop entry's Exec syntax.
   */
  it('waits for one application to finish before opening the next', async () => {
    const { events, sender } = collector()
    const files = ['/tmp/a.mkv', '/tmp/b.mkv']

    const started = Date.now()
    await openSeries('s-1', files, 'slow.desktop', sender)
    const elapsed = Date.now() - started

    const opening = events.filter((e) => e.type === 'opening')
    expect(opening).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'done', opened: 2, stopped: false })
    // Two two-second applications in sequence cannot finish in under three.
    expect(elapsed).toBeGreaterThan(3000)
    // And it did not auto-advance: each one was genuinely waited for.
    expect(events.filter((e) => e.type === 'finished-one').every((e) => e.handedOff === false)).toBe(true)
  }, 20000)

  /*
   * A single-instance application hands the file to the copy already running
   * and exits at once. Advancing on that would dump the whole list into it,
   * which is the exact thing this mode exists to prevent, so it stops and
   * waits to be told instead.
   */
  it('stops and waits when the application hands off instead of finishing', async () => {
    const { events, sender } = collector()
    const run = openSeries('s-2', ['/tmp/a.mkv', '/tmp/b.mkv'], 'instant.desktop', sender)

    await until(() => events.some((e) => e.type === 'finished-one'))
    const first = events.find((e) => e.type === 'finished-one')!
    expect(first.handedOff).toBe(true)

    // It is parked: the second file has not been opened on its own.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(events.filter((e) => e.type === 'opening')).toHaveLength(1)

    // ...until it is advanced by hand.
    expect(advanceSeries('s-2')).toBe(true)
    await run
    expect(events.filter((e) => e.type === 'opening')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'done', opened: 2 })
  }, 20000)

  it('stops the rest of the list on request', async () => {
    const { events, sender } = collector()
    const run = openSeries('s-3', ['/tmp/a.mkv', '/tmp/b.mkv', '/tmp/c.mkv'], 'instant.desktop', sender)

    await until(() => events.some((e) => e.type === 'finished-one'))
    expect(stopSeries('s-3')).toBe(true)
    await run

    expect(events.at(-1)).toMatchObject({ type: 'done', stopped: true })
    expect(events.filter((e) => e.type === 'opening')).toHaveLength(1)
  }, 20000)

  it('reports an application that is no longer installed', async () => {
    const { events, sender } = collector()
    await openSeries('s-4', ['/tmp/a.mkv'], 'gone.desktop', sender)
    expect(events).toEqual([{ type: 'error', message: 'That application is no longer installed.' }])
  })

  it('advancing an unknown or unparked series does nothing', () => {
    expect(advanceSeries('nope')).toBe(false)
    expect(stopSeries('nope')).toBe(false)
  })
})
