/**
 * The keyboard, driven through the real `Tui`.
 *
 * Only the network is stubbed; the panes hold entries the way a listing leaves
 * them, so these are the same code paths a keystroke takes in a terminal.
 */
import { describe, expect, it, vi } from 'vitest'
import type { App } from '@profullstack/hqtui'
import { renderToScreen } from '@profullstack/hqtui/testing'
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
/** Draws the real frame, so a click lands where the user would see it. */
const frame = (app: Tui) =>
  renderToScreen(({ ui, theme, width, height }) => app.view(ui, theme, width, height), {
    width: 100,
    height: 30,
    collapseBorders: true,
  })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

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

describe('the mouse', () => {
  it('selects a row with a click, and focuses whichever pane the click is in', () => {
    const app = tui()
    const screen = frame(app)
    const gamma = screen.find('gamma.ts')!
    expect(screen.click(gamma.x, gamma.y)).toBe(true)
    expect(pane(app, 'left').index).toBe(2)
    expect(state(app).active).toBe('left')
    // Anywhere in the right pane, including its empty space.
    expect(screen.click(75, 10)).toBe(true)
    expect(state(app).active).toBe('right')
  })

  it('opens a directory on a double-click, and .. takes it back up', async () => {
    const app = tui([entry('src', { isDirectory: true }), entry('a.ts')])
    let screen = frame(app)
    const src = screen.find('src')!
    screen.click(src.x, src.y, { clicks: 2 })
    await settle()
    expect(pane(app, 'left').path).toBe('/tmp/a/src')

    // The listing failed (there is no such directory) and `..` is still there.
    screen = frame(app)
    const up = screen.find('..')!
    screen.click(up.x, up.y, { clicks: 2 })
    await settle()
    expect(pane(app, 'left').path).toBe('/tmp/a')
  })

  it('a file does not open on a double-click', async () => {
    const app = tui()
    const screen = frame(app)
    const beta = screen.find('beta.ts')!
    screen.click(beta.x, beta.y, { clicks: 2 })
    await settle()
    expect(pane(app, 'left').path).toBe('/tmp/a')
    expect(pane(app, 'left').index).toBe(1)
  })

  it('drives the key bar: endpoint opens the picker, a server points the pane, outside closes it', async () => {
    const app = tui()
    let screen = frame(app)
    const endpoint = screen.find('c endpoint')!
    screen.click(endpoint.x, endpoint.y)
    await settle()
    expect(state(app).overlay?.kind).toBe('picker')

    screen = frame(app)
    screen.click(0, 0)
    expect(state(app).overlay).toBeNull()

    screen = frame(app)
    screen.click(endpoint.x, endpoint.y)
    await settle()
    screen = frame(app)
    const blue = screen.find('deploy@10.0.0.7')!
    screen.click(blue.x, blue.y)
    await settle()
    expect(state(app).overlay).toBeNull()
    expect(pane(app, 'left').label).toBe('blue')
  })

  it('opens the help from the header and closes it from its button', async () => {
    const app = tui()
    let screen = frame(app)
    const help = screen.find('? help')!
    screen.click(help.x, help.y)
    await settle()
    expect(state(app).overlay?.kind).toBe('help')
    screen = frame(app)
    const close = screen.find('esc  close')!
    screen.click(close.x, close.y)
    expect(state(app).overlay).toBeNull()
  })

  it('quits from the key bar through the app it is attached to', async () => {
    const app = tui()
    const quit = vi.fn()
    app.attach({ quit, invalidate: () => {} } as unknown as App)
    const screen = frame(app)
    const q = screen.find('q quit')!
    screen.click(q.x, q.y)
    await settle()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('gives a dialog the whole screen: the key bar under it is not clickable', async () => {
    const app = tui()
    const quit = vi.fn()
    app.attach({ quit, invalidate: () => {} } as unknown as App)
    await press(app, '?')
    const screen = frame(app)
    // Bottom row, where the key bar is: the click is taken by the backdrop,
    // which closes the help, and nothing underneath acts on it.
    expect(screen.click(2, 29)).toBe(true)
    expect(state(app).overlay).toBeNull()
    expect(quit).not.toHaveBeenCalled()
  })

  it('clears the last message, like a key does', async () => {
    const app = tui()
    await press(app, '.')
    expect(state(app).status).not.toBeNull()
    const screen = frame(app)
    const alpha = screen.find('alpha.ts')!
    screen.click(alpha.x, alpha.y)
    expect(state(app).status).toBeNull()
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
