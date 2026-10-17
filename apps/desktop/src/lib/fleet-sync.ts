/**
 * Fleet Sync's pure helpers, kept out of the component so they are tested
 * without the app's module aliases.
 */

import { formatBytes, formatDuration, formatRate } from './format'

export type FailedDestination = { name: string; host: string; message: string; log: string[] }

/** The text a person pastes into an issue or a chat: what failed, where, and rsync's own words. */
export function errorReport(d: FailedDestination): string {
  return [`Fleet Sync to ${d.name}${d.host ? ` (${d.host})` : ''} failed: ${d.message}`, ...(d.log.length ? ['', ...d.log] : [])].join('\n')
}

/**
 * Where the source lands when the destination box is empty (or says the same
 * path): the same path on every host. rsync copies a folder named without a
 * trailing slash INTO its destination, so sending `~/a/ideas` to `~/a/ideas`
 * would make `~/a/ideas/ideas`. Sending it to the parent, `~/a/`, makes
 * `~/a/ideas`, and works for a single file too. A path the user typed that
 * differs from the source is theirs and goes through untouched.
 */
export function destinationFor(sourcePath: string, destPath: string): string {
  const source = sourcePath.trim()
  const dest = destPath.trim()
  if (dest && dest !== source) return dest
  if (source.endsWith('/')) return source
  const slash = source.lastIndexOf('/')
  if (slash === -1) return '.'
  return source.slice(0, slash + 1)
}

export type ProgressNumbers = { percent: number; bytesTransferred: number; bytesPerSecond: number }

/** A percentage that does not read 0% for the first hours of a big transfer: one decimal below 10%. */
export function formatPercent(percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  return p < 10 ? `${(Math.floor(p * 10) / 10).toFixed(1)}%` : `${Math.floor(p)}%`
}

/**
 * The line under a running destination: how much, how fast, how long. rsync's
 * progress gives bytes moved and a percentage of the whole, so the total and the
 * time left are worked out from those, and only once there is enough to go on.
 */
export function progressDetail(p: ProgressNumbers): string {
  const parts = [formatPercent(p.percent)]
  const total = p.percent >= 0.1 ? p.bytesTransferred / (p.percent / 100) : null
  parts.push(total ? `${formatBytes(p.bytesTransferred)} of ~${formatBytes(total)}` : formatBytes(p.bytesTransferred))
  if (p.bytesPerSecond > 0) {
    parts.push(formatRate(p.bytesPerSecond))
    if (total && total > p.bytesTransferred) parts.push(`~${formatDuration((total - p.bytesTransferred) / p.bytesPerSecond)} left`)
  }
  return parts.join(' · ')
}

export type FileRow = { path: string; size: number | null; action: 'add' | 'update' | 'delete' }
export const FILE_ROWS = 200

/**
 * The files a destination is receiving, newest first: rsync itemizes each one as
 * it starts, so the top row is the file in flight. Directories and unchanged
 * files are not traffic and are left out; a path seen again moves to the top.
 */
export function recordFile(
  rows: readonly FileRow[],
  change: { action: string; path: string; size?: number | null; isDirectory?: boolean },
  limit = FILE_ROWS,
): FileRow[] {
  if (change.isDirectory || !['add', 'update', 'delete'].includes(change.action)) return [...rows]
  const row: FileRow = { path: change.path, size: change.size ?? null, action: change.action as FileRow['action'] }
  return [row, ...rows.filter((r) => r.path !== change.path)].slice(0, limit)
}
