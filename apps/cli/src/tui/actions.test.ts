/**
 * Plugin actions in the TUI: the `a` menu and the job panel.
 *
 * Frames are asserted as rendered text, and the keyboard and the mouse are
 * driven through the real `Tui` with a fake plugin host, so these are the
 * code paths a keystroke or a click takes in a terminal.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToScreen, renderToText } from '@profullstack/hqtui/testing'
import type { ActionResult, ProgressSink } from '@diskpush/plugin-api'
import type { ActionChoice, PluginHost } from '../plugins.js'
import { key } from './keys.fixture.js'
import { blankJob, blankPane, pushJobLog, type ActionsOverlay, type Entry } from './model.js'
import { type Action, type ViewState, draw } from './view.js'

vi.mock('@diskpush/ssh-core', () => ({
  SshSession: { connect: async () => ({ close: () => {} }) },
  SftpBrowser: { open: async () => ({ list: async () => [], close: () => {} }) },
}))
vi.mock('@diskpush/database', () => ({ knownHostsPath: () => '/tmp/known_hosts.test' }))

const { Tui, listLocal } = await import('./app.js')

const CHOICES: ActionChoice[] = [
  { pluginId: 'mediaanalyzer', pluginName: 'MediaAnalyzer', actionId: 'analyze', label: 'Analyze media', description: 'Describe each photo and video.', key: 'm' },
  { pluginId: 'mediaanalyzer', pluginName: 'MediaAnalyzer', actionId: 'analyze-sort', label: 'Analyze and sort into folders', description: 'Moves files. Undoable.', key: 'f' },
]

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({ name, isDirectory: false, size: 0, modifiedAt: null, ...over })

function state(over: Partial<ViewState> = {}): ViewState {
  const left = blankPane('Local', '/home/me/photos')
  left.entries = [entry('2024', { isDirectory: true }), entry('cat.jpg', { size: 2048 })]
  return {
    panes: { left, right: blankPane('prod', '/srv') },
    active: 'left',
    overlay: null,
    transfer: null,
    document: null,
    filtering: null,
    status: null,
    choices: [],
    now: new Date('2026-09-24T12:00:00.000Z'),
    plugins: true,
    ...over,
  }
}

const actionsOverlay = (over: Partial<ActionsOverlay> = {}): ActionsOverlay => ({
  kind: 'actions',
  side: 'left',
  dir: '/home/me/photos',
  names: ['cat.jpg'],
  what: 'cat.jpg',
  choices: CHOICES,
  index: 0,
  hover: null,
  ...over,
})

const text = (s: ViewState, width = 100, height = 30) =>
  renderToText(({ ui, theme }) => draw(ui, theme, width, height, s), { width, height, collapseBorders: true })

describe('the actions menu frame', () => {
  it('lists the actions with their letters and says what the highlighted one does', () => {
    const screen = text(state({ overlay: actionsOverlay() }))
    expect(screen).toContain('Actions: cat.jpg')
    expect(screen).toMatch(/m\s+Analyze media\s+MediaAnalyzer/)
    expect(screen).toMatch(/f\s+Analyze and sort into folders/)
    expect(screen).toContain('MediaAnalyzer')
    expect(screen).toContain('Describe each photo and video.')
    expect(screen).toMatch(/⏎\s*run/)
  })

  it('describes the row under the pointer rather than the cursor', () => {
    expect(text(state({ overlay: actionsOverlay({ hover: 1 }) }))).toContain('Moves files. Undoable.')
  })

  it('offers `a` in the key bar only when plugins are loaded, and the cap is a button', () => {
    expect(text(state({ plugins: false }))).not.toMatch(/\ba\s+actions/)
    // Quit keeps its place in a 100-column terminal; the extra cap goes last.
    expect(text(state()).trimEnd().split('\n').at(-1)).toContain('q quit')
    expect(text(state(), 120).trimEnd().split('\n').at(-1)).toMatch(/q quit\s+a actions/)
    const actions: Action[] = []
    const rendered = renderToScreen(
      ({ ui, theme }) => draw(ui, theme, 120, 30, state(), { onAction: (action) => actions.push(action) }),
      { width: 120, height: 30, collapseBorders: true },
    )
    const cap = rendered.find('a actions')!
    expect(cap).not.toBeNull()
    rendered.click(cap.x, cap.y)
    expect(actions).toEqual(['actions'])
  })
})

describe('the job panel frame', () => {
  it('shows a running action: its name, the file, the count and cancel', () => {
    const job = blankJob('Analyze media', 'photos/2024', 'left', () => {})
    job.startedAt = Date.parse('2026-09-24T11:59:30.000Z')
    job.total = 40
    job.done = 12
    job.currentFile = '2024/beach.jpg'
    pushJobLog(job, 'warn', 'clip.mp4: skipped, videos need ffmpeg')
    const screen = text(state({ job }))
    expect(screen).toContain('Analyze media')
    expect(screen).toContain('photos/2024')
    expect(screen).toContain('12/40')
    expect(screen).toContain('2024/beach.jpg')
    expect(screen).toContain('videos need ffmpeg')
    expect(screen).toContain('esc  cancel')
    expect(screen).toContain('0:30')
  })

  it('shows how it ended', () => {
    const job = blankJob('Analyze media', 'cat.jpg', 'left', () => {})
    job.running = false
    job.endedAt = job.startedAt + 5000
    job.outcome = { ok: false, message: 'Out of credit: 3 files not uploaded.' }
    const screen = text(state({ job }))
    expect(screen).toContain('Analyze media: failed')
    expect(screen).toContain('Out of credit')
    expect(screen).toContain('esc  dismiss')
  })
})

/** A plugin host that records what it was asked and finishes when told to. */
function fakeHost() {
  const runs: { choice: ActionChoice; dir: string; names: readonly string[] }[] = []
  let finish!: (result: ActionResult) => void
  let progress!: ProgressSink
  let signal!: AbortSignal
  const host: PluginHost = {
    async actionsFor(_dir, entries) {
      return entries.some((e) => e.name.endsWith('.jpg') || e.isDirectory) ? CHOICES : []
    },
    run(choice, dir, names, sink, abort) {
      runs.push({ choice, dir, names })
      progress = sink
      signal = abort
      return new Promise((resolve) => {
        finish = resolve
        abort.addEventListener('abort', () => resolve({ ok: false, message: 'stopped' }))
      })
    },
  }
  return { host, runs, finish: (result: ActionResult) => finish(result), progress: () => progress, signal: () => signal }
}

function app(host: PluginHost | null) {
  const root = mkdtempSync(join(tmpdir(), 'diskpush-actions-'))
  mkdirSync(join(root, 'album'))
  writeFileSync(join(root, 'album', 'dog.jpg'), 'x')
  writeFileSync(join(root, 'cat.jpg'), 'x')
  writeFileSync(join(root, 'notes.txt'), 'x')
  const left = blankPane('Local', root)
  left.entries = listLocal(root)
  const tui = new Tui(left, blankPane('prod', '/srv', { id: 'c1', name: 'prod' } as never), [], undefined, undefined, host)
  return { tui, root }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const frame = (tui: InstanceType<typeof Tui>) =>
  renderToScreen(({ ui, theme, width, height }) => tui.view(ui, theme, width, height), { width: 100, height: 30, collapseBorders: true })

describe('running an action from the TUI', () => {
  it('opens on `a`, runs on enter with the directory and the bare name, and shows the result', async () => {
    const fake = fakeHost()
    const { tui, root } = app(fake.host)
    // Rows: album/, cat.jpg, notes.txt; the cursor to cat.jpg.
    await tui.onKey(key('down'))
    await tui.onKey(key('a'))
    expect(tui.snapshot().overlay).toMatchObject({ kind: 'actions', dir: root, names: ['cat.jpg'] })

    await tui.onKey(key('enter'))
    await settle()
    expect(fake.runs).toEqual([{ choice: CHOICES[0], dir: root, names: ['cat.jpg'] }])
    expect(tui.snapshot().job?.running).toBe(true)

    fake.progress().start(1)
    fake.progress().update({ done: 1, currentFile: 'cat.jpg' })
    expect(tui.snapshot().job).toMatchObject({ done: 1, total: 1, currentFile: 'cat.jpg' })

    fake.finish({ ok: true, message: 'Described 1 of 1 file.' })
    await settle()
    expect(tui.snapshot().job).toMatchObject({ running: false, outcome: { ok: true, message: 'Described 1 of 1 file.' } })
    expect(tui.snapshot().status?.text).toBe('Described 1 of 1 file.')

    await tui.onKey(key('escape'))
    expect(tui.snapshot().job).toBeNull()
  })

  it('runs an action from its letter, and on a nested row hands over the folder that holds it', async () => {
    const fake = fakeHost()
    const { tui, root } = app(fake.host)
    await tui.onKey(key('enter')) // unfold album/
    await settle()
    await tui.onKey(key('down')) // album/dog.jpg
    await tui.onKey(key('a'))
    await tui.onKey(key('f'))
    await settle()
    expect(fake.runs[0]).toMatchObject({ dir: join(root, 'album'), names: ['dog.jpg'], choice: { actionId: 'analyze-sort' } })
  })

  it('runs the action under a single click, and lights the row under the pointer', async () => {
    const fake = fakeHost()
    const { tui } = app(fake.host)
    await tui.onKey(key('down'))
    await tui.onKey(key('a'))
    let screen = frame(tui)
    const row = screen.find('Analyze and sort into folders')!
    screen.hover(row.x, row.y)
    expect(tui.snapshot().overlay).toMatchObject({ kind: 'actions', hover: 1 })
    screen = frame(tui)
    expect(screen.text()).toContain('Moves files. Undoable.')
    screen.click(row.x, row.y)
    await settle()
    expect(fake.runs.map((run) => run.choice.actionId)).toEqual(['analyze-sort'])
    expect(tui.snapshot().overlay).toBeNull()
  })

  it('cancels a running action with escape through its signal', async () => {
    const fake = fakeHost()
    const { tui } = app(fake.host)
    await tui.onKey(key('down'))
    await tui.onKey(key('a'))
    await tui.onKey(key('enter'))
    await settle()
    await tui.onKey(key('escape'))
    await settle()
    expect(fake.signal().aborted).toBe(true)
    expect(tui.snapshot().job?.outcome).toMatchObject({ ok: false, cancelled: true })
  })

  it('says why there is nothing to offer: no plugin fits, a server pane, or no plugins', async () => {
    const fake = fakeHost()
    const { tui } = app(fake.host)
    await tui.onKey(key('end')) // notes.txt
    await tui.onKey(key('a'))
    expect(tui.snapshot().overlay).toBeNull()
    expect(tui.snapshot().status?.text).toBe('No plugin action applies to notes.txt.')

    await tui.onKey(key('tab'))
    await tui.onKey(key('a'))
    expect(tui.snapshot().status?.text).toMatch(/local files/)

    const bare = app(null).tui
    await bare.onKey(key('a'))
    expect(bare.snapshot().status?.text).toMatch(/No plugins/)
  })
})
