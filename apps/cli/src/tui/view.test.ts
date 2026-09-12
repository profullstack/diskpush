/**
 * The screen itself, asserted on as text.
 *
 * The old TUI wrote escape sequences straight to stdout, so the only way to
 * know what it drew was to run it in a pty and look. HQTUI renders to an
 * in-memory framebuffer, which means the frame is just a value — and defects
 * like a path scrolling off the panel or a dialog that never appears become
 * ordinary failing assertions.
 */
import { describe, expect, it } from 'vitest'
import { renderToScreen, renderToText } from '@profullstack/hqtui/testing'
import { blankPane, type Entry, type Pane, type Transfer } from './model.js'
import { type Action, type ViewHandlers, type ViewState, draw, filterChoices, truncatePath } from './view.js'

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  isDirectory: false,
  size: 0,
  modifiedAt: null,
  ...over,
})

function pane(label: string, path: string, entries: Entry[], over: Partial<Pane> = {}): Pane {
  return { ...blankPane(label, path), entries, ...over }
}

function state(over: Partial<ViewState> = {}): ViewState {
  return {
    panes: {
      left: pane('Local', '/home/me/project', [
        entry('src', { isDirectory: true }),
        entry('README.md', { size: 4096, modifiedAt: '2026-09-08T09:00:00.000Z' }),
      ]),
      right: pane('prod', '/srv/app', [entry('bundle.js', { size: 1_500_000 })]),
    },
    active: 'left',
    overlay: null,
    transfer: null,
    filtering: null,
    status: null,
    choices: [
      { label: 'Local', detail: 'this machine', connection: null, path: '/home/me' },
      { label: 'prod', detail: 'deploy@prod.example', connection: null, path: '/srv/app' },
    ],
    now: new Date('2026-09-08T12:00:00.000Z'),
    ...over,
  }
}

const screen = (s: ViewState, width = 100, height = 30) =>
  renderToText(({ ui, theme }) => draw(ui, theme, width, height, s), { width, height, collapseBorders: true })

describe('the two panes', () => {
  it('shows both endpoints, their paths and their contents', () => {
    const text = screen(state())
    expect(text).toContain('Local')
    expect(text).toContain('/home/me/project')
    expect(text).toContain('prod')
    expect(text).toContain('/srv/app')
    expect(text).toContain('README.md')
    expect(text).toContain('bundle.js')
  })

  it('marks directories and sizes the files', () => {
    const text = screen(state())
    expect(text).toContain('▸ src')
    expect(text).toContain('4.1K')
    expect(text).toContain('1.5M')
  })

  it('names the sync direction in the header, so `s` is never a guess', () => {
    expect(screen(state())).toContain('Local → prod')
    expect(screen(state({ active: 'right' }))).toContain('Local ← prod')
  })

  it('says an empty directory is empty instead of drawing a blank box', () => {
    const empty = state()
    empty.panes.right = pane('prod', '/srv/app', [])
    expect(screen(empty)).toContain('Empty')
  })

  it('explains an empty pane that a filter emptied', () => {
    const filtered = state()
    filtered.panes.left = pane('Local', '/tmp', [entry('a.ts')], { filter: 'zzz' })
    expect(screen(filtered)).toContain('Nothing matches')
  })

  it('shows the error from a listing that failed', () => {
    const failed = state()
    failed.panes.right = { ...pane('prod', '/srv/app', []), error: 'Permission denied' }
    expect(screen(failed)).toContain('Permission denied')
  })

  it('keeps a long path inside its own pane', () => {
    // The path is drawn in the panel's top border, which cannot wrap: an
    // untruncated one used to run straight through the pane beside it.
    const deep = state()
    deep.panes.left = pane('Local', `/${'very-long-directory-name/'.repeat(12)}`, [entry('a.ts')])
    for (const line of screen(deep).split('\n')) expect(line.length).toBeLessThanOrEqual(100)
  })

  it('keeps the endpoint name AND the path on both panes when the path is long', () => {
    // Both live in the same top border row and the box gives the path
    // priority, so a path budgeted against the full pane width cost one pane
    // its title and the other its path — decided by a one-column rounding
    // difference between two panes showing the very same directory.
    const long = state()
    const path = '/home/me/src/profullstack/diskpush/.claude/worktrees/tui-hqtui'
    long.panes.left = pane('Local', path, [entry('a.ts')])
    long.panes.right = pane('prod', path, [entry('a.ts')])
    const header = screen(long).split('\n')[1] ?? ''
    expect(header).toContain('Local')
    expect(header).toContain('prod')
    expect(header.match(/tui-hqtui/g) ?? []).toHaveLength(2)
  })
})

describe('truncatePath', () => {
  it('keeps the end, which is the part that names the directory', () => {
    // Shortened from the head instead, every worktree under the same repo
    // renders as the identical string.
    expect(truncatePath('/home/me/src/profullstack/diskpush', 14)).toBe('…tack/diskpush')
  })

  it('leaves a path that already fits alone', () => {
    expect(truncatePath('/srv/app', 40)).toBe('/srv/app')
  })
})

describe('the mouse', () => {
  // Clicks are driven through the same hit-test the app runs, so these prove
  // that the cell showing a thing is the cell that does it — which is
  // otherwise only observable by running a real terminal and moving the mouse.
  const frame = (s: ViewState, handlers: ViewHandlers = {}) =>
    renderToScreen(({ ui, theme }) => draw(ui, theme, 100, 30, s, handlers), {
      width: 100,
      height: 30,
      collapseBorders: true,
    })

  const runningTransfer = (running: boolean): Transfer => ({
    mode: 'sync',
    from: '/home/me/project/',
    to: 'deploy@prod:/srv/app/',
    running,
    progress: null,
    recent: [],
    summary: { add: 0, update: 0, metadata: 0, delete: 0, unchanged: 0, error: 0 },
    outcome: running ? null : { ok: true, message: 'Sync complete' },
    cancel: () => {},
  })

  it('registers a clickable, scrollable region for each pane', () => {
    expect(frame(state()).regions.length).toBeGreaterThanOrEqual(2)
  })

  it('selects a row on one click, and reports the row under the pointer', () => {
    const log: unknown[] = []
    const rendered = frame(state(), {
      onSelectRow: (side, index) => log.push(['select', side, index]),
      onHoverRow: (side, index) => log.push(['hover', side, index]),
    })
    const readme = rendered.find('README.md')!
    expect(rendered.click(readme.x, readme.y)).toBe(true)
    const src = rendered.find('src')!
    rendered.click(src.x, src.y)
    rendered.hover(readme.x, readme.y)
    expect(log).toEqual([
      ['select', 'left', 1],
      ['select', 'left', 0],
      ['hover', 'left', 1],
    ])
  })

  it('puts .. above a listing that has a parent, and one click on it goes up', () => {
    const log: unknown[] = []
    const rendered = frame(state(), {
      onSelectRow: (side, index) => log.push(['select', side, index]),
      onGoUp: (side) => log.push(['up', side]),
    })
    const up = rendered.find('..')!
    expect(rendered.click(up.x, up.y)).toBe(true)
    expect(log).toEqual([['up', 'left']])
  })

  it('draws an unfolded directory as a tree under its parent, with the fold state on the marker', () => {
    const s = state()
    s.panes.left.children.set('src', [entry('index.ts', { size: 120 }), entry('lib', { isDirectory: true })])
    s.panes.left.unfolded.add('src')
    const text = screen(s)
    expect(text).toContain('▾ src')
    expect(text).toContain('index.ts')
    expect(text).toContain('▸ lib')
    // A folded sibling stays folded, and a listing on its way says so.
    s.panes.left.unfolded.delete('src')
    s.panes.left.listing.add('src')
    expect(screen(s)).toContain('… src')
    expect(screen(s)).not.toContain('index.ts')
  })

  it('lights the row under the pointer', () => {
    const lit = state()
    lit.panes.left.hover = 1
    const plain = frame(state())
    const hovered = frame(lit)
    const readme = plain.find('README.md')!
    expect(hovered.cell(readme.x, readme.y).bg).not.toBe(plain.cell(readme.x, readme.y).bg)
  })

  it('has no .. at the root, and keeps it on a listing that failed', () => {
    const root = state()
    root.panes.left.path = '/'
    root.panes.right.path = '/'
    expect(screen(root)).not.toContain('..')

    const broken = state()
    broken.panes.left.error = 'Permission denied'
    const text = screen(broken)
    expect(text).toContain('Permission denied')
    expect(text).toContain('..')
  })

  it('makes every key in the bar a button for its action', () => {
    const actions: Action[] = []
    const rendered = frame(state(), { onAction: (action) => actions.push(action) })
    for (const cap of ['tab pane', '⏎ open', 'c endpoint', 'p preview', 's sync', '/ filter', 'o sort', 'q quit']) {
      const at = rendered.find(cap)!
      expect(at, cap).not.toBeNull()
      expect(rendered.click(at.x, at.y), cap).toBe(true)
    }
    expect(actions).toEqual(['pane', 'open', 'endpoint', 'preview', 'sync', 'filter', 'sort', 'quit'])
  })

  it('switches panes from the direction in the header, and opens help from ?', () => {
    const actions: Action[] = []
    const rendered = frame(state(), { onAction: (action) => actions.push(action) })
    const direction = rendered.find('Local → prod')!
    rendered.click(direction.x, direction.y)
    const help = rendered.find('? help')!
    rendered.click(help.x, help.y)
    expect(actions).toEqual(['pane', 'help'])
  })

  it('focuses a pane from a click on its chrome', () => {
    const focused: string[] = []
    const rendered = frame(state(), { onPaneFocus: (side) => focused.push(side) })
    const right = rendered.find('▪ prod')!
    rendered.click(right.x, right.y)
    const left = rendered.find('▪ Local')!
    rendered.click(left.x, left.y)
    expect(focused).toEqual(['right', 'left'])
  })

  it('chooses a server from the picker with one click, and closes it from outside', () => {
    const log: unknown[] = []
    const rendered = frame(state({ overlay: { kind: 'picker', query: '', index: 0 } }), {
      onPickChoice: (choice) => log.push(['pick', choice.label]),
      onDismissOverlay: () => log.push('dismiss'),
    })
    const prod = rendered.find('deploy@prod.example')!
    rendered.click(prod.x, prod.y)
    rendered.click(0, 0)
    expect(log).toEqual([['pick', 'prod'], 'dismiss'])
  })

  it('answers the host-key question only from its buttons', () => {
    const log: unknown[] = []
    const rendered = frame(
      state({
        overlay: { kind: 'hostKey', host: 'prod', fingerprint: 'SHA256:abc', keyType: 'ed25519', decide: () => {} },
      }),
      { onHostKeyDecide: (trust) => log.push(trust), onDismissOverlay: () => log.push('dismiss') },
    )
    const trust = rendered.find('y  trust')!
    rendered.click(trust.x, trust.y)
    const cancel = rendered.find('n  cancel')!
    rendered.click(cancel.x, cancel.y)
    // A stray click outside the dialog is taken, and answers nothing.
    expect(rendered.click(0, 0)).toBe(true)
    expect(log).toEqual([true, false])
  })

  it('closes the help from its button or from outside', () => {
    let closed = 0
    const rendered = frame(state({ overlay: { kind: 'help' } }), { onDismissOverlay: () => closed++ })
    const close = rendered.find('esc  close')!
    rendered.click(close.x, close.y)
    rendered.click(0, 0)
    expect(closed).toBe(2)
  })

  it('dismisses a finished transfer with a click, and never cancels a running one that way', () => {
    const actions: Action[] = []
    const done = frame(state({ transfer: runningTransfer(false) }), { onAction: (action) => actions.push(action) })
    const complete = done.find('Sync complete')!
    done.click(complete.x, complete.y)
    expect(actions).toEqual(['dismissTransfer'])

    const running = frame(state({ transfer: runningTransfer(true) }), { onAction: (action) => actions.push(action) })
    const syncing = running.find('Syncing')!
    running.click(syncing.x, syncing.y)
    expect(actions).toEqual(['dismissTransfer'])
    // Cancel lives on the key bar, spelled out.
    const cancel = running.find('esc cancel')!
    running.click(cancel.x, cancel.y)
    expect(actions).toEqual(['dismissTransfer', 'cancelTransfer'])
  })
})

describe('the key bar', () => {
  it('lists the bindings that apply, and swaps them for the dialog that is up', () => {
    expect(screen(state())).toContain('sync')
    const picking = screen(state({ overlay: { kind: 'picker', query: '', index: 0 } }))
    expect(picking).toContain('cancel')
    expect(picking).not.toContain('endpoint')
  })

  it('gives way to the last message when there is one', () => {
    const text = screen(state({ status: { text: 'Synced 12 files', tone: 'ok' } }))
    expect(text).toContain('Synced 12 files')
  })

  it('becomes the filter prompt while a filter is being typed', () => {
    const filtering = state({ filtering: 'left' })
    filtering.panes.left.filter = 'read'
    expect(screen(filtering)).toContain('read')
  })
})

describe('the endpoint picker', () => {
  it('lists the endpoints and narrows as the query is typed', () => {
    expect(screen(state({ overlay: { kind: 'picker', query: '', index: 0 } }))).toContain('deploy@prod.example')
    const narrowed = screen(state({ overlay: { kind: 'picker', query: 'pro', index: 0 } }))
    expect(narrowed).toContain('prod')
    expect(narrowed).not.toContain('this machine')
  })

  it('matches on the detail line too, so a hostname finds its alias', () => {
    const choices = [
      { label: 'Local', detail: 'this machine', connection: null, path: '/' },
      { label: 'blue', detail: 'deploy@10.0.0.7', connection: null, path: '/' },
    ]
    expect(filterChoices(choices, '10.0.0').map((c) => c.label)).toEqual(['blue'])
  })
})

describe('the host-key question', () => {
  it('puts the fingerprint on screen with both answers', () => {
    const text = screen(
      state({
        overlay: {
          kind: 'hostKey',
          host: 'prod.example',
          fingerprint: 'SHA256:PZm9Q0uz2pFmxYnAlY7lHi5zZ9UgUJmZAlKZLB5Fpuo',
          keyType: 'ssh-ed25519',
          decide: () => {},
        },
      }),
    )
    expect(text).toContain('prod.example')
    expect(text).toContain('SHA256:PZm9Q0uz2pFmxYnAlY7lHi5zZ9UgUJmZAlKZLB5Fpuo')
    expect(text).toContain('trust')
    expect(text).toContain('cancel')
  })
})

describe('the transfer panel', () => {
  const transfer = (over: Partial<Transfer> = {}): Transfer => ({
    mode: 'sync',
    from: '/home/me/project/',
    to: 'deploy@prod:/srv/app/',
    running: true,
    progress: {
      bytesTransferred: 12_000_000,
      percent: 42,
      bytesPerSecond: 3_000_000,
      elapsedSeconds: 4,
      filesTransferred: 18,
      filesRemaining: 30,
      filesTotal: 48,
    },
    recent: [{ action: 'add', path: 'dist/app.js', itemize: null, isDirectory: false, size: 2048 }],
    summary: { add: 7, update: 2, metadata: 0, delete: 0, unchanged: 91, error: 0 },
    outcome: null,
    cancel: () => {},
    ...over,
  })

  it('shows progress, rate and the files as they go by', () => {
    const text = screen(state({ transfer: transfer() }))
    expect(text).toContain('Syncing')
    expect(text).toContain('42%')
    expect(text).toContain('3.0M/s')
    expect(text).toContain('dist/app.js')
    expect(text).toContain('+7')
  })

  it('offers cancel while it runs and dismiss once it is done', () => {
    expect(screen(state({ transfer: transfer() }))).toContain('cancel')
    const done = transfer({ running: false, outcome: { ok: true, message: 'Sync complete' } })
    expect(screen(state({ transfer: done }))).toContain('dismiss')
  })

  it('finishes the bar at 100%, not at rsync\'s last printed figure', () => {
    const done = transfer({ running: false, progress: { ...transfer().progress!, percent: 80 }, outcome: { ok: true, message: 'Preview complete' } })
    const text = screen(state({ transfer: done }))
    expect(text).toContain('100%')
    expect(text).not.toContain('80%')
  })

  it('reports a failure instead of a finished bar', () => {
    const failed = transfer({ running: false, outcome: { ok: false, message: 'rsync: connection unexpectedly closed' } })
    const text = screen(state({ transfer: failed }))
    expect(text).toContain('Failed')
    expect(text).toContain('connection unexpectedly closed')
  })

  it('gives its rows back to the panes on a short terminal', () => {
    // Half a transfer panel is worse than none: the panes are the app.
    const text = screen(state({ transfer: transfer() }), 100, 14)
    expect(text).not.toContain('Syncing')
    expect(text).toContain('README.md')
  })
})

describe('the help overlay', () => {
  it('documents every binding, the mouse, and why Mirror is not one', () => {
    const text = screen(state({ overlay: { kind: 'help' } }))
    expect(text).toContain('switch pane')
    expect(text).toContain('fold or unfold')
    expect(text).toContain('Mirror')
  })
})
