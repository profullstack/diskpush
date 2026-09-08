/**
 * The keyboard, driven through the real `Tui`.
 *
 * Only the network is stubbed; the panes hold entries the way a listing leaves
 * them, so these are the same code paths a keystroke takes in a terminal.
 */
import { describe, expect, it, vi } from 'vitest'
import { key } from './keys.fixture.js'
import type { Entry, Pane, Side } from './model.js'

vi.mock('@diskpush/ssh-core', () => ({
  SshSession: { connect: async () => ({ close: () => {} }) },
  SftpBrowser: { open: async () => ({ list: async () => [], close: () => {} }) },
}))
vi.mock('@diskpush/database', () => ({ knownHostsPath: () => '/tmp/known_hosts.test' }))

const { Tui, blankPane } = await import('./app.js')
type Tui = InstanceType<typeof Tui>

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  isDirectory: false,
  size: 0,
  modifiedAt: null,
  ...over,
})

const LEFT = [entry('alpha.ts'), entry('beta.ts', { size: 900 }), entry('gamma.ts', { size: 20 }), entry('.hidden')]

function tui(leftEntries: Entry[] = LEFT) {
  const left = blankPane('Local', '/tmp/a')
  const right = blankPane('Local', '/tmp/b')
  left.entries = leftEntries
  const app = new Tui(left, right, [
    { label: 'Local', detail: 'this machine', connection: null, path: '/tmp' },
    { label: 'prod', detail: 'deploy@prod.example', connection: null, path: '/srv' },
    { label: 'blue', detail: 'deploy@10.0.0.7', connection: null, path: '.' },
  ])
  return app
}

const state = (app: Tui) => app.snapshot()
const pane = (app: Tui, side: Side): Pane => state(app).panes[side]
const press = async (app: Tui, ...names: string[]) => {
  for (const name of names) await app.onKey(key(name))
}

describe('navigation', () => {
  it('moves the cursor and stops at both ends', async () => {
    const app = tui()
    await press(app, 'down', 'down')
    expect(pane(app, 'left').index).toBe(2)
    await press(app, 'up', 'up', 'up', 'up')
    expect(pane(app, 'left').index).toBe(0)
    await press(app, 'end')
    // Three visible entries: the dotfile is hidden, so end is index 2, not 3.
    expect(pane(app, 'left').index).toBe(2)
  })

  it('switches panes with tab, which is what decides the sync direction', async () => {
    const app = tui()
    expect(state(app).active).toBe('left')
    await press(app, 'tab')
    expect(state(app).active).toBe('right')
  })

  it('quits on q and on ctrl+c', async () => {
    await expect(tui().onKey(key('q'))).resolves.toBe(false)
    await expect(tui().onKey(key('c', { ctrl: true }))).resolves.toBe(false)
  })
})

describe('the filter', () => {
  it('narrows the listing as it is typed and keeps it on enter', async () => {
    const app = tui()
    await press(app, '/')
    expect(state(app).filtering).toBe('left')
    await press(app, 'b', 'e')
    expect(pane(app, 'left').filter).toBe('be')
    await press(app, 'enter')
    expect(state(app).filtering).toBeNull()
    expect(pane(app, 'left').filter).toBe('be')
  })

  it('is cleared by escape rather than left behind on a pane you cannot see into', async () => {
    const app = tui()
    await press(app, '/', 'b', 'escape')
    expect(pane(app, 'left').filter).toBe('')
    expect(state(app).filtering).toBeNull()
  })

  it('swallows the keys it is given: q types a q, it does not quit', async () => {
    // Every printable key belongs to the prompt while it is up. Letting `q`
    // through would close the app mid-word.
    const app = tui()
    await press(app, '/')
    await expect(app.onKey(key('q'))).resolves.toBe(true)
    expect(pane(app, 'left').filter).toBe('q')
  })

  it('backspaces', async () => {
    const app = tui()
    await press(app, '/', 'a', 'b', 'backspace')
    expect(pane(app, 'left').filter).toBe('a')
  })
})

describe('sorting and hidden files', () => {
  it('cycles the sort with o and reverses it with O', async () => {
    const app = tui()
    expect(pane(app, 'left').sort).toBe('name')
    await press(app, 'o')
    expect(pane(app, 'left').sort).toBe('size')
    await press(app, 'o')
    expect(pane(app, 'left').sort).toBe('time')
    await press(app, 'o')
    expect(pane(app, 'left').sort).toBe('name')

    // A shifted letter arrives as its own character with `shift` unset, which
    // is why this is matched on case and not on the modifier.
    await app.onKey(key('O'))
    expect(pane(app, 'left').descending).toBe(true)
  })

  it('toggles dotfiles with .', async () => {
    const app = tui()
    await press(app, '.')
    expect(pane(app, 'left').showHidden).toBe(true)
  })
})

describe('the endpoint picker', () => {
  it('opens on c, types into its query and closes on escape', async () => {
    const app = tui()
    await press(app, 'c')
    expect(state(app).overlay?.kind).toBe('picker')
    await press(app, 'b', 'l')
    expect(state(app).overlay).toMatchObject({ kind: 'picker', query: 'bl' })
    await press(app, 'escape')
    expect(state(app).overlay).toBeNull()
  })

  it('keeps the selection inside the matches as the query narrows them', async () => {
    // The index was pointing at the third of three endpoints; typing a query
    // that leaves one behind must not select past the end of the list.
    const app = tui()
    await press(app, 'c')
    await press(app, 'down', 'down')
    await press(app, 'p', 'r', 'o')
    await press(app, 'down')
    expect(state(app).overlay).toMatchObject({ index: 0 })
  })

  it('points the pane at the endpoint that enter selects', async () => {
    const app = tui()
    await press(app, 'c')
    await press(app, 'p', 'r', 'o')
    await press(app, 'enter')
    expect(pane(app, 'left').label).toBe('prod')
    expect(pane(app, 'left').path).toBe('/srv')
  })

  it('escape closes the picker rather than the app', async () => {
    const app = tui()
    await press(app, 'c')
    await expect(app.onKey(key('escape'))).resolves.toBe(true)
  })
})

describe('the help overlay', () => {
  it('opens on ? and closes on the next key, but q still quits', async () => {
    const app = tui()
    await press(app, '?')
    expect(state(app).overlay?.kind).toBe('help')
    await press(app, 'escape')
    expect(state(app).overlay).toBeNull()

    await press(app, '?')
    await expect(app.onKey(key('q'))).resolves.toBe(false)
  })
})

describe('the last message', () => {
  it('is cleared by the next keystroke, so it never answers the wrong question', async () => {
    const app = tui()
    await press(app, '.')
    expect(state(app).status).not.toBeNull()
    await press(app, 'down')
    expect(state(app).status).toBeNull()
  })
})
