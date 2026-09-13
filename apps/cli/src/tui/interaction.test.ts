/**
 * The keyboard, driven through the real `Tui`.
 *
 * Only the network is stubbed; the panes hold entries the way a listing leaves
 * them, so these are the same code paths a keystroke takes in a terminal.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { App, MouseEvent } from '@profullstack/hqtui'
import { renderToScreen } from '@profullstack/hqtui/testing'
import { key } from './keys.fixture.js'
import { visibleRows, type Entry, type Pane, type Side } from './model.js'

vi.mock('@diskpush/ssh-core', () => ({
  SshSession: { connect: async () => ({ close: () => {} }) },
  SftpBrowser: {
    open: async () => ({
      list: async () => [],
      readHead: async (path: string) => {
        if (path.endsWith('gone.md')) throw new Error('No such file')
        return { bytes: Buffer.from('# Remote\n\nover sftp\n'), size: 4096 }
      },
      close: () => {},
    }),
  },
}))
vi.mock('@diskpush/database', () => ({ knownHostsPath: () => '/tmp/known_hosts.test' }))

const { Tui, blankPane, listLocal } = await import('./app.js')
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
const move = (x: number, y: number): MouseEvent => ({
  type: 'mouse',
  action: 'move',
  button: 'none',
  x,
  y,
  scroll: 0,
  clicks: 1,
  ctrl: false,
  alt: false,
  shift: false,
})

/** A real directory on disk, because unfolding lists it for real. */
function realTree() {
  const root = mkdtempSync(join(tmpdir(), 'diskpush-tui-'))
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n')
  writeFileSync(join(root, 'src', 'lib', 'deep.ts'), 'export {}\n')
  writeFileSync(join(root, 'a.ts'), '')
  const left = blankPane('Local', root)
  left.entries = listLocal(root)
  const right = blankPane('Local', '/tmp/b')
  const app = new Tui(left, right, [])
  return { app, root }
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

  it('unfolds a directory on one click, shows its listing beneath it, and folds it on the next', async () => {
    const { app } = realTree()
    let screen = frame(app)
    const src = screen.find('src')!
    screen.click(src.x, src.y)
    await settle()
    expect(pane(app, 'left').unfolded.has('src')).toBe(true)
    expect(pane(app, 'left').index).toBe(0)

    screen = frame(app)
    expect(screen.contains('index.ts')).toBe(true)
    expect(screen.contains('▾ src')).toBe(true)
    // Nested directories unfold the same way, one level at a time.
    const lib = screen.find('lib')!
    screen.click(lib.x, lib.y)
    await settle()
    screen = frame(app)
    expect(screen.contains('deep.ts')).toBe(true)
    expect(pane(app, 'left').unfolded.has('src/lib')).toBe(true)

    // Folding the parent hides everything under it, and remembers it.
    screen.click(src.x, src.y)
    await settle()
    screen = frame(app)
    expect(screen.contains('index.ts')).toBe(false)
    expect(pane(app, 'left').children.has('src')).toBe(true)
  })

  it('one click on .. goes up', async () => {
    const { app, root } = realTree()
    const screen = frame(app)
    const up = screen.find('..')!
    screen.click(up.x, up.y)
    await settle()
    expect(pane(app, 'left').path).toBe(dirname(root))
  })

  it('a click on a file only selects it', async () => {
    const app = tui()
    const screen = frame(app)
    const beta = screen.find('beta.ts')!
    screen.click(beta.x, beta.y)
    await settle()
    expect(pane(app, 'left').path).toBe('/tmp/a')
    expect(pane(app, 'left').index).toBe(1)
  })

  it('lights the row under the pointer, and puts it out when the pointer leaves the rows', () => {
    const app = tui()
    const screen = frame(app)
    const beta = screen.find('beta.ts')!
    expect(screen.hover(beta.x, beta.y)).toBe(true)
    app.onMouse(move(beta.x, beta.y))
    expect(pane(app, 'left').hover).toBe(1)
    // A move the frame's rows did not claim: the header, say.
    expect(screen.hover(2, 0)).toBe(false)
    app.onMouse(move(2, 0))
    expect(pane(app, 'left').hover).toBeNull()
  })

  it('walks the tree from the keyboard: → unfolds and steps in, ← folds and climbs, then leaves', async () => {
    const { app, root } = realTree()
    await press(app, 'right')
    expect(pane(app, 'left').unfolded.has('src')).toBe(true)
    await press(app, 'right')
    expect(pane(app, 'left').index).toBe(1)
    await press(app, 'left')
    expect(pane(app, 'left').index).toBe(0)
    await press(app, 'left')
    expect(pane(app, 'left').unfolded.has('src')).toBe(false)
    await press(app, 'left')
    expect(pane(app, 'left').path).toBe(dirname(root))
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

describe('preview', () => {
  /** Two real directories, so `p` runs the real rsync as a dry run. */
  function twoTrees() {
    const { app, root } = realTree()
    const other = mkdtempSync(join(tmpdir(), 'diskpush-tui-dst-'))
    const right = pane(app, 'right')
    right.path = other
    right.entries = []
    return { app, root, other }
  }
  const finished = async (app: Tui) => {
    for (let i = 0; i < 200 && state(app).transfer?.running !== false; i += 1) await new Promise((r) => setTimeout(r, 25))
    return state(app).transfer!
  }

  it('covers the selected directory, mirrored to the same place in the other pane', async () => {
    const { app, root, other } = twoTrees()
    await press(app, 'p')
    const transfer = await finished(app)
    expect(transfer.mode).toBe('preview')
    expect(transfer.from).toBe(`${root}/src/`)
    expect(transfer.to).toBe(`${other}/src/`)
    expect(transfer.what).toBe('src')
    expect(transfer.outcome?.ok).toBe(true)
    // Two files and a directory would be created over there.
    expect(transfer.summary.add).toBeGreaterThanOrEqual(3)
    expect(transfer.scanned?.total).toBeGreaterThanOrEqual(3)
    expect(state(app).status?.text).toMatch(/^Preview: \d+ to add/)
  })

  it('says so when there is nothing to do, with the count of files it checked', async () => {
    const { app, root, other } = twoTrees()
    mkdirSync(join(other, 'src', 'lib'), { recursive: true })
    for (const rel of ['src/index.ts', 'src/lib/deep.ts']) writeFileSync(join(other, rel), 'export {}\n')
    await press(app, 'p')
    const transfer = await finished(app)
    expect(transfer.outcome?.ok).toBe(true)
    expect(transfer.summary.add + transfer.summary.update).toBe(0)
    expect(state(app).status?.text).toMatch(/^Already in sync: \d+ files checked/)
    const screen = frame(app)
    expect(screen.contains('Already in sync')).toBe(true)
    expect(screen.contains('Nothing to do')).toBe(true)
    void root
  })

  it('syncs the selected file into the directory that holds it over there, and refreshes that pane in place', async () => {
    const { app, root, other } = twoTrees()
    // Unfold src and select src/index.ts (rows: src, lib, index.ts).
    await press(app, 'right', 'down', 'down')
    expect(pane(app, 'left').index).toBe(2)
    await press(app, 's')
    const transfer = await finished(app)
    expect(transfer.mode).toBe('sync')
    expect(transfer.from).toBe(`${root}/src/index.ts`)
    expect(transfer.to).toBe(`${other}/src/`)
    expect(transfer.outcome?.ok).toBe(true)
    expect(listLocal(join(other, 'src')).map((e) => e.name)).toEqual(['index.ts'])
    // The destination pane was re-read, not reset.
    expect(pane(app, 'right').entries.map((e) => e.name)).toEqual(['src'])
  })

  it('reports esc as a cancel, not a failure', async () => {
    const { app } = twoTrees()
    // Enough files that the dry run is still walking when esc lands.
    const wide = join(pane(app, 'left').path, 'wide')
    mkdirSync(wide)
    for (let i = 0; i < 4000; i += 1) writeFileSync(join(wide, `f${i}.txt`), String(i))
    pane(app, 'left').entries = listLocal(pane(app, 'left').path)
    await press(app, 'end')
    // Not awaited: `p` resolves only when rsync has finished, and the point
    // is to press esc while it is still walking.
    const running = app.onKey(key('p'))
    await settle()
    await press(app, 'escape')
    await running
    const transfer = await finished(app)
    if (transfer.outcome?.cancelled) {
      expect(transfer.outcome.message).toBe('Preview cancelled.')
      expect(state(app).status).toEqual({ text: 'Preview cancelled', tone: 'warn' })
      expect(frame(app).contains('signal')).toBe(false)
    } else {
      // rsync beat the escape on this machine; the only other honest outcome is a finished preview.
      expect(transfer.outcome?.ok).toBe(true)
    }
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

describe('viewing a file', () => {
  /** A directory with one of everything the viewer tells apart. */
  function docs() {
    const root = mkdtempSync(join(tmpdir(), 'diskpush-view-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), '# Title\n\nHello **world**\n')
    writeFileSync(join(root, 'NOTES'), '# Notes\n\n- one\n- two\n\nSee [the docs](https://example.com).\n')
    writeFileSync(join(root, 'code.ts'), 'const a = 1\nconst b = 2\n')
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    writeFileSync(join(root, 'long.txt'), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    const left = blankPane('Local', root)
    left.entries = listLocal(root)
    const right = blankPane('Local', '/tmp/b')
    const app = new Tui(left, right, [])
    return { app, root }
  }
  /** Puts the cursor on a row by name. */
  const goto = (app: Tui, name: string, side: Side = 'left') => {
    const p = pane(app, side)
    p.index = visibleRows(p).findIndex((row) => row.entry.name === name)
    expect(p.index).toBeGreaterThanOrEqual(0)
  }
  const document = (app: Tui) => state(app).document

  it('v opens the file under the cursor, rendered under the panes, and v closes it', async () => {
    const { app, root } = docs()
    goto(app, 'README.md')
    await press(app, 'v')
    expect(document(app)?.kind).toBe('markdown')
    expect(document(app)?.location).toBe(join(root, 'README.md'))
    expect(document(app)?.loading).toBe(false)
    const screen = frame(app)
    expect(screen.contains('Hello world')).toBe(true)
    expect(screen.contains('# Title')).toBe(false)
    expect(screen.contains('esc close')).toBe(true)
    await press(app, 'v')
    expect(document(app)).toBeNull()
  })

  it('⏎ on a file opens it too, and esc closes it before it would quit', async () => {
    const { app } = docs()
    goto(app, 'code.ts')
    await press(app, 'enter')
    expect(document(app)?.kind).toBe('text')
    expect(frame(app).contains('2 │ const b = 2')).toBe(true)
    expect(await app.onKey(key('escape'))).toBe(true)
    expect(document(app)).toBeNull()
    expect(await app.onKey(key('escape'))).toBe(false)
  })

  it('v on a directory opens nothing and says why', async () => {
    const { app } = docs()
    goto(app, 'src')
    await press(app, 'v')
    expect(document(app)).toBeNull()
    expect(state(app).status?.text).toContain('v views a file')
  })

  it('tells a binary from text, and reads an extensionless README as markdown', async () => {
    const { app } = docs()
    goto(app, 'blob.bin')
    await press(app, 'v')
    expect(document(app)?.kind).toBe('binary')
    expect(frame(app).contains('00000000  89 50 4e 47 00 01 02')).toBe(true)
    goto(app, 'NOTES')
    await press(app, 'v', 'v')
    expect(document(app)?.kind).toBe('markdown')
    expect(frame(app).contains('• one')).toBe(true)
  })

  it('follows the cursor from file to file, and stays put over a directory', async () => {
    const { app } = docs()
    goto(app, 'code.ts')
    await press(app, 'v')
    expect(document(app)?.name).toBe('code.ts')
    // Files sort by name after the one directory: src, blob.bin, code.ts, long.txt, NOTES, README.md.
    await press(app, 'down')
    await settle()
    expect(document(app)?.name).toBe('long.txt')
    await press(app, 'up', 'up')
    await settle()
    expect(document(app)?.name).toBe('blob.bin')
    // `src` sorts first: the cursor is on a directory and the viewer keeps the last file.
    await press(app, 'up')
    await settle()
    expect(pane(app, 'left').index).toBe(0)
    expect(document(app)?.name).toBe('blob.bin')
  })

  it('a click on another file switches the viewer to it', async () => {
    const { app } = docs()
    goto(app, 'code.ts')
    await press(app, 'v')
    const screen = frame(app)
    const readme = screen.find('README.md')!
    screen.click(readme.x, readme.y)
    await settle()
    expect(document(app)?.name).toBe('README.md')
  })

  it('pages with pgdn, pgup, g and G while the arrows still move the cursor', async () => {
    const { app } = docs()
    goto(app, 'long.txt')
    await press(app, 'v')
    // A frame tells the app how many rows the document has.
    frame(app)
    await press(app, 'pagedown')
    expect(document(app)?.scroll).toBe(16)
    await press(app, 'G')
    expect(document(app)?.scroll).toBe(200 - 16)
    await press(app, 'pageup')
    expect(document(app)?.scroll).toBe(200 - 32)
    await press(app, 'g')
    expect(document(app)?.scroll).toBe(0)
    const before = pane(app, 'left').index
    await press(app, 'up')
    expect(pane(app, 'left').index).toBe(before - 1)
  })

  it('scrolls with the wheel over the document, and clamps at the end', async () => {
    const { app } = docs()
    goto(app, 'long.txt')
    await press(app, 'v')
    let screen = frame(app)
    const line = screen.find('line 3')!
    expect(screen.scroll(line.x, line.y, 1)).toBe(true)
    expect(document(app)?.scroll).toBe(3)
    for (let i = 0; i < 200; i += 1) screen.scroll(line.x, line.y, 1)
    expect(document(app)?.scroll).toBe(200 - 16)
    screen = frame(app)
    expect(screen.contains('200 │ line 200')).toBe(true)
  })

  it('reads a remote file over sftp, and shows the error when it cannot', async () => {
    const connection = { id: 'prod', name: 'prod', host: 'prod.example', port: 22, username: 'deploy' }
    const left = blankPane('prod', '/srv/app', connection as never)
    left.entries = [
      { name: 'README.md', isDirectory: false, size: 4096, modifiedAt: null },
      { name: 'gone.md', isDirectory: false, size: 1, modifiedAt: null },
    ]
    const app = new Tui(left, blankPane('Local', '/tmp/b'), [])
    goto(app, 'README.md')
    await press(app, 'v')
    expect(document(app)?.kind).toBe('markdown')
    expect(document(app)?.location).toBe('deploy@prod.example:/srv/app/README.md')
    expect(frame(app).contains('over sftp')).toBe(true)
    // `gone.md` sorts before it.
    await press(app, 'up')
    await settle()
    expect(document(app)?.error).toBe('No such file')
    expect(frame(app).contains('No such file')).toBe(true)
  })

  it('a preview takes the rows back', async () => {
    const { app } = docs()
    goto(app, 'code.ts')
    await press(app, 'v')
    await press(app, 'p')
    expect(document(app)).toBeNull()
    expect(state(app).transfer).not.toBeNull()
  })
})
