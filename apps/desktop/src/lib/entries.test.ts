import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@/lib/api'
import { DEFAULT_SORT, isNavigable, nextSort, visibleEntries, type Sort } from './entries.js'

function entry(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/x/${name}`,
    type: 'file',
    size: 0,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    mode: 0o644,
    ...overrides,
  }
}

const directory = (name: string, overrides: Partial<FileEntry> = {}) =>
  entry(name, { type: 'directory', size: 4096, ...overrides })

function order(entries: FileEntry[], sort: Sort, options: { filter?: string; showHidden?: boolean } = {}) {
  return visibleEntries(entries, {
    filter: options.filter ?? '',
    showHidden: options.showHidden ?? true,
    sort,
  }).map((item) => item.name)
}

describe('isNavigable', () => {
  /**
   * The bug this exists to prevent: `~/data -> /mnt/vdb` on a server was a row
   * that could not be opened. SFTP's readdir types a link the way lstat does,
   * and the pane only walked into rows typed `directory`, so every
   * double-click on it did nothing at all.
   */
  it('opens a link that points at a directory', () => {
    expect(isNavigable({ type: 'symlink', targetType: 'directory' })).toBe(true)
  })

  it('does not open a link that points at a file', () => {
    expect(isNavigable({ type: 'symlink', targetType: 'file' })).toBe(false)
  })

  it('does not open a link whose target could not be resolved', () => {
    // A broken link, or one pointing where this user cannot stat: there is
    // nothing to walk into, and guessing yes turns a click into an error.
    expect(isNavigable({ type: 'symlink', targetType: undefined })).toBe(false)
  })

  it('opens a real directory', () => {
    expect(isNavigable({ type: 'directory' })).toBe(true)
  })

  it('does not open a file, whatever a stale targetType says', () => {
    expect(isNavigable({ type: 'file', targetType: 'directory' })).toBe(false)
  })
})

describe('nextSort', () => {
  it('opens size and modified on the answer you clicked for', () => {
    // Nobody clicks Size to find the smallest file.
    expect(nextSort(DEFAULT_SORT, 'size')).toEqual({ key: 'size', direction: 'desc' })
    expect(nextSort(DEFAULT_SORT, 'modified')).toEqual({ key: 'modified', direction: 'desc' })
  })

  it('opens name forwards', () => {
    expect(nextSort({ key: 'size', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' })
  })

  it('flips the column already being sorted on', () => {
    expect(nextSort({ key: 'name', direction: 'asc' }, 'name')).toEqual({ key: 'name', direction: 'desc' })
    expect(nextSort({ key: 'name', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' })
  })
})

describe('visibleEntries', () => {
  it('sorts names the way a person reads them, not by code point', () => {
    // Plain localeCompare puts file10 before file2, and a capitalised name
    // into a block of its own above every lowercase one.
    const names = order([entry('file10'), entry('file2'), entry('Photos.txt'), entry('apps.txt')], DEFAULT_SORT)
    expect(names).toEqual(['apps.txt', 'file2', 'file10', 'Photos.txt'])
  })

  it('keeps directories above files in both directions', () => {
    const listing = [entry('a.txt'), directory('zoo'), entry('z.txt'), directory('apps')]
    expect(order(listing, { key: 'name', direction: 'asc' })).toEqual(['apps', 'zoo', 'a.txt', 'z.txt'])
    expect(order(listing, { key: 'name', direction: 'desc' })).toEqual(['zoo', 'apps', 'z.txt', 'a.txt'])
  })

  it('groups a link to a directory with the directories', () => {
    const listing = [entry('a.txt'), entry('data', { type: 'symlink', targetType: 'directory' })]
    expect(order(listing, DEFAULT_SORT)).toEqual(['data', 'a.txt'])
  })

  it('sorts by size, largest first, without reordering the folders', () => {
    // Directories report their own inode size, which the pane draws as an em
    // dash: ordering identical-looking rows by an invisible number reads as a bug.
    const listing = [
      directory('zoo', { size: 4096 }),
      directory('apps', { size: 40960 }),
      entry('small.txt', { size: 10 }),
      entry('big.bin', { size: 9_000_000 }),
    ]
    expect(order(listing, { key: 'size', direction: 'desc' })).toEqual(['apps', 'zoo', 'big.bin', 'small.txt'])
    expect(order(listing, { key: 'size', direction: 'asc' })).toEqual(['apps', 'zoo', 'small.txt', 'big.bin'])
  })

  it('sorts by modified time, newest first', () => {
    const listing = [
      entry('old.txt', { modifiedAt: '2020-06-01T00:00:00.000Z' }),
      entry('new.txt', { modifiedAt: '2026-09-01T00:00:00.000Z' }),
      entry('middle.txt', { modifiedAt: '2024-01-01T00:00:00.000Z' }),
    ]
    expect(order(listing, { key: 'modified', direction: 'desc' })).toEqual(['new.txt', 'middle.txt', 'old.txt'])
  })

  it('sorts an unreadable mtime as the epoch instead of poisoning the comparison', () => {
    // A NaN comparison returns NaN for every pair, which leaves the whole
    // listing in arrival order and looks like sorting silently stopped working.
    const listing = [entry('b.txt', { modifiedAt: '' }), entry('a.txt', { modifiedAt: '2026-01-01T00:00:00.000Z' })]
    expect(order(listing, { key: 'modified', direction: 'desc' })).toEqual(['a.txt', 'b.txt'])
  })

  it('breaks ties by name, so both panes draw an equal pair the same way', () => {
    const listing = [entry('b.txt', { size: 10 }), entry('a.txt', { size: 10 })]
    expect(order(listing, { key: 'size', direction: 'desc' })).toEqual(['a.txt', 'b.txt'])
    expect(order(listing, { key: 'modified', direction: 'desc' })).toEqual(['a.txt', 'b.txt'])
  })

  it('still hides dotfiles and honours the filter', () => {
    const listing = [entry('.hidden'), entry('notes.txt'), entry('other.md')]
    expect(order(listing, DEFAULT_SORT, { showHidden: false })).toEqual(['notes.txt', 'other.md'])
    expect(order(listing, DEFAULT_SORT, { showHidden: true, filter: 'HID' })).toEqual(['.hidden'])
  })

  it('leaves the array it was given alone', () => {
    const listing = [entry('b.txt'), entry('a.txt')]
    order(listing, DEFAULT_SORT)
    expect(listing.map((item) => item.name)).toEqual(['b.txt', 'a.txt'])
  })
})
