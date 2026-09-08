import { describe, expect, it } from 'vitest'
import {
  type Entry,
  type Pane,
  blankPane,
  clampIndex,
  compareEntries,
  formatSize,
  formatWhen,
  pushChange,
  selectedEntry,
  visibleEntries,
  TRANSFER_LOG_LIMIT,
} from './model.js'
import type { Transfer } from './model.js'

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  isDirectory: false,
  size: 0,
  modifiedAt: null,
  ...over,
})

function paneWith(entries: Entry[], over: Partial<Pane> = {}): Pane {
  return { ...blankPane('Local', '/tmp'), entries, ...over }
}

describe('visibleEntries', () => {
  it('hides dotfiles until they are asked for', () => {
    const pane = paneWith([entry('.env'), entry('app.ts')])
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['app.ts'])
    pane.showHidden = true
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['.env', 'app.ts'])
  })

  it('filters case-insensitively on a substring', () => {
    const pane = paneWith([entry('README.md'), entry('index.ts')], { filter: 'ME' })
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['README.md'])
  })

  it('keeps directories on top however the sort runs', () => {
    // Reversing a size sort must not bury the directories you navigate with
    // under the data, which is the whole reason they are pinned.
    const pane = paneWith(
      [entry('big.bin', { size: 9000 }), entry('src', { isDirectory: true }), entry('small.txt', { size: 1 })],
      { sort: 'size', descending: true },
    )
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['src', 'big.bin', 'small.txt'])
  })

  it('breaks ties on name, so equal sizes are not left in listing order', () => {
    const pane = paneWith([entry('b'), entry('a')], { sort: 'size' })
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['a', 'b'])
  })

  it('sorts by time when asked', () => {
    const pane = paneWith(
      [
        entry('old', { modifiedAt: '2020-01-01T00:00:00.000Z' }),
        entry('new', { modifiedAt: '2026-01-01T00:00:00.000Z' }),
      ],
      { sort: 'time', descending: true },
    )
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['new', 'old'])
  })
})

describe('the cursor', () => {
  it('indexes what is on screen, not the raw listing', () => {
    // A filter that removes everything above the cursor would otherwise select
    // a different file than the one under the highlight.
    const pane = paneWith([entry('a.ts'), entry('b.ts'), entry('c.ts')], { filter: 'c', index: 0 })
    expect(selectedEntry(pane)?.name).toBe('c.ts')
  })

  it('is pulled back onto a row that exists when the list shrinks', () => {
    const pane = paneWith([entry('a'), entry('b'), entry('c')], { index: 2 })
    pane.filter = 'a'
    clampIndex(pane)
    expect(pane.index).toBe(0)
  })

  it('is null on an empty listing rather than a phantom row', () => {
    expect(selectedEntry(paneWith([]))).toBeNull()
  })
})

describe('compareEntries', () => {
  it('orders names naturally when the sort is by name', () => {
    expect(compareEntries(entry('a'), entry('b'), 'name', false)).toBeLessThan(0)
    expect(compareEntries(entry('a'), entry('b'), 'name', true)).toBeGreaterThan(0)
  })
})

describe('formatSize', () => {
  it('stays narrow enough for the column it lives in', () => {
    expect(formatSize(999)).toBe('999B')
    expect(formatSize(1500)).toBe('1.5K')
    expect(formatSize(1_500_000)).toBe('1.5M')
    expect(formatSize(15_000_000)).toBe('15M')
  })
})

describe('formatWhen', () => {
  const now = new Date('2026-09-08T12:00:00.000Z')

  it('shows a clock for today and a year for anything old', () => {
    const today = new Date('2026-09-08T08:30:00.000Z')
    expect(formatWhen(today.toISOString(), now)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatWhen('2019-03-04T00:00:00.000Z', now)).toMatch(/^Mar 2019$/)
  })

  it('says nothing rather than "Invalid Date" when there is no timestamp', () => {
    expect(formatWhen(null, now)).toBe('')
    expect(formatWhen('not a date', now)).toBe('')
  })
})

describe('the transfer log', () => {
  const transfer = (): Transfer => ({
    mode: 'sync',
    from: '/a/',
    to: '/b/',
    running: true,
    progress: null,
    recent: [],
    summary: { add: 0, update: 0, metadata: 0, delete: 0, unchanged: 0, error: 0 },
    outcome: null,
    cancel: () => {},
  })

  it('counts every change but only keeps the last screenful', () => {
    // A million-file sync must not hold a million objects alive just to draw
    // the last twenty of them.
    const t = transfer()
    for (let i = 0; i < TRANSFER_LOG_LIMIT + 50; i += 1) {
      pushChange(t, { action: 'add', path: `file-${i}`, itemize: null, isDirectory: false, size: 1 })
    }
    expect(t.summary.add).toBe(TRANSFER_LOG_LIMIT + 50)
    expect(t.recent).toHaveLength(TRANSFER_LOG_LIMIT)
    expect(t.recent.at(-1)?.path).toBe(`file-${TRANSFER_LOG_LIMIT + 49}`)
  })
})
