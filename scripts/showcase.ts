/**
 * Frames for the hqtui.com apps showcase.
 *
 * A fixture rather than a live session. A screenshot taken from a real run
 * changes on every capture and would show whatever happened to be in somebody's
 * home directory and on the far end of an SSH connection — neither reviewable
 * nor safe to publish.
 *
 * The state is built from the real types, not cast into shape, so this stops
 * compiling if the model changes underneath it. That is the point: a showcase
 * frame that has silently drifted from the app is worse than no frame.
 */
import type { Change, ChangeSummary, RsyncProgress } from '@diskpush/schemas'
import { blankPane, type Entry, type Pane, type Transfer } from '../apps/cli/src/tui/model.js'
import { draw, type ViewState } from '../apps/cli/src/tui/view.js'

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  isDirectory: false,
  size: 0,
  modifiedAt: null,
  ...over,
})

const pane = (label: string, path: string, entries: Entry[], over: Partial<Pane> = {}): Pane => ({
  ...blankPane(label, path),
  entries,
  ...over,
})

const change = (path: string, action: Change['action'], size: number | null, over: Partial<Change> = {}): Change => ({
  action,
  path,
  itemize: null,
  isDirectory: false,
  size,
  ...over,
})

const LOCAL: Entry[] = [
  entry('..', { isDirectory: true }),
  entry('apps', { isDirectory: true, modifiedAt: '2026-09-08T09:12:00.000Z' }),
  entry('packages', { isDirectory: true, modifiedAt: '2026-09-07T21:40:00.000Z' }),
  entry('dist', { isDirectory: true, modifiedAt: '2026-09-08T09:18:00.000Z' }),
  entry('README.md', { size: 4213, modifiedAt: '2026-09-06T11:02:00.000Z' }),
  entry('bun.lock', { size: 184320, modifiedAt: '2026-09-08T08:55:00.000Z' }),
  entry('package.json', { size: 1180, modifiedAt: '2026-09-05T16:31:00.000Z' }),
]

const REMOTE: Entry[] = [
  entry('..', { isDirectory: true }),
  entry('releases', { isDirectory: true, modifiedAt: '2026-09-08T09:20:00.000Z' }),
  entry('diskpush-0.6.0.tar.gz', { size: 9437184, modifiedAt: '2026-09-08T09:19:00.000Z' }),
  entry('diskpush-0.5.0.tar.gz', { size: 9214464, modifiedAt: '2026-09-01T14:05:00.000Z' }),
  entry('checksums.txt', { size: 312, modifiedAt: '2026-09-08T09:19:00.000Z' }),
]

const SUMMARY: ChangeSummary = {
  add: 1, update: 1, metadata: 0, delete: 0, unchanged: 1, error: 0,
}

const PROGRESS: RsyncProgress = {
  bytesTransferred: 7_340_032,
  percent: 78,
  bytesPerSecond: 2_306_867,
  elapsedSeconds: 3.2,
  filesTransferred: 2,
  filesRemaining: 1,
  filesTotal: 3,
}

const TRANSFER: Transfer = {
  mode: 'sync',
  from: '~/src/profullstack/diskpush/dist',
  to: 'deploy@edge-01:/srv/releases',
  running: true,
  progress: PROGRESS,
  recent: [
    change('diskpush-0.6.0.tar.gz', 'add', 9_437_184),
    change('checksums.txt', 'update', 312),
    change('diskpush-0.5.0.tar.gz', 'unchanged', 9_214_464),
  ],
  summary: SUMMARY,
  outcome: null,
  cancel: () => {},
}

const STATE: ViewState = {
  panes: {
    left: pane('Local', '~/src/profullstack/diskpush', LOCAL, { index: 3 }),
    right: pane('deploy@edge-01', '/srv/releases', REMOTE, { index: 2 }),
  },
  active: 'left',
  overlay: null,
  transfer: TRANSFER,
  filtering: null,
  status: { text: 'Syncing dist → /srv/releases', tone: 'info' },
  choices: [],
  now: new Date('2026-09-08T09:21:00.000Z'),
}

const WIDTH = 132
const HEIGHT = 34

export const frames = [
  {
    name: 'diskpush',
    width: WIDTH,
    height: HEIGHT,
    draw: ({ ui, theme, height }: Parameters<typeof drawAdapter>[0]) =>
      drawAdapter({ ui, theme, height }),
  },
]

/** hqtui hands the renderer a container and a theme; `draw` also wants the size. */
function drawAdapter({ ui, theme, height }: {
  ui: Parameters<typeof draw>[0]
  theme: Parameters<typeof draw>[1]
  height: number
}): void {
  draw(ui, theme, WIDTH, height, STATE)
}
