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
