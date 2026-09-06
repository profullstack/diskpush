import type { FileEntry } from '@/lib/api'

/**
 * Whether opening this row should walk into it.
 *
 * A remote listing reports link types the way lstat does, so `~/data -> /mnt/vdb`
 * arrives as `symlink` and used to be a row that swallowed every double-click.
 * What matters is what is behind the link, not that it is one — and an
 * unresolved target (a broken link, or one this user cannot stat) is not
 * something to walk into.
 */
export function isNavigable(entry: Pick<FileEntry, 'type' | 'targetType'>): boolean {
  return entry.type === 'directory' || (entry.type === 'symlink' && entry.targetType === 'directory')
}

export type SortKey = 'name' | 'size' | 'modified'
export type SortDirection = 'asc' | 'desc'
export type Sort = { key: SortKey; direction: SortDirection }

/** What a pane sorts by until someone clicks a header: the file-manager default. */
export const DEFAULT_SORT: Sort = { key: 'name', direction: 'asc' }

/**
 * The direction a column starts in the first time it is clicked.
 *
 * Name reads forwards, but nobody clicks Size to find the smallest file or
 * Modified to find the oldest, so those open on the answer you came for.
 */
export function initialDirection(key: SortKey): SortDirection {
  return key === 'name' ? 'asc' : 'desc'
}

/** Clicking the active column flips it; clicking another one switches to it. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, direction: initialDirection(key) }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}

/**
 * Names in the order a person reads them: `file10` after `file2`, and case
 * ignored, so `Photos` does not sort into a block of its own above `apps`.
 *
 * The exact-string fallback is not decoration. A collator told to ignore case
 * calls `README` and `readme` equal, and two entries that compare equal are
 * left in whatever order the listing arrived in — stable within one sort, but
 * different between the local lister and SFTP, so the same folder would draw
 * one way on the left and another on the right.
 */
function byName(a: FileEntry, b: FileEntry): number {
  const collated = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  if (collated !== 0) return collated
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** A missing or unparseable mtime sorts as the epoch, rather than poisoning the comparator with NaN. */
function modifiedAt(entry: FileEntry): number {
  const parsed = Date.parse(entry.modifiedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * The row order for a pane.
 *
 * Directories stay above files in every direction, the way every file manager
 * behaves: reversing Size should not shuffle folders into the middle of the
 * list. A link to a directory is grouped as one, because that is what it opens
 * as.
 *
 * Sorting by size leaves that folder block on name. Directories report their
 * own inode size, not the size of their contents, and the pane already draws
 * that as an em dash — ordering visibly identical rows by a number nobody can
 * see reads as a bug.
 */
export function compareEntries(sort: Sort): (a: FileEntry, b: FileEntry) => number {
  const sign = sort.direction === 'asc' ? 1 : -1
  return (a, b) => {
    if (isNavigable(a) !== isNavigable(b)) return isNavigable(a) ? -1 : 1
    if (sort.key === 'size') {
      if (isNavigable(a)) return byName(a, b)
      return a.size === b.size ? byName(a, b) : sign * (a.size - b.size)
    }
    if (sort.key === 'modified') {
      const difference = modifiedAt(a) - modifiedAt(b)
      return difference === 0 ? byName(a, b) : sign * difference
    }
    return sign * byName(a, b)
  }
}

/**
 * What a pane actually draws: hidden files, the filter box and the sort in one
 * place, so the header click that keeps the keyboard cursor on its row can ask
 * for the next order instead of predicting it.
 */
export function visibleEntries(
  entries: readonly FileEntry[],
  options: { filter: string; showHidden: boolean; sort: Sort },
): FileEntry[] {
  const needle = options.filter.toLowerCase()
  return entries
    .filter((entry) => options.showHidden || !entry.name.startsWith('.'))
    .filter((entry) => needle === '' || entry.name.toLowerCase().includes(needle))
    .sort(compareEntries(options.sort))
}
