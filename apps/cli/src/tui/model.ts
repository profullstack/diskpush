/**
 * The state behind the two-pane browser, and the pure functions over it.
 *
 * Everything here is data: no terminal, no ssh, no rsync. The view renders a
 * snapshot of it and the app mutates it, which is what makes both testable
 * without a pty.
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Change, ChangeSummary, Connection, RsyncProgress } from '@diskpush/schemas'

export type Entry = {
  name: string
  isDirectory: boolean
  size: number
  /** ISO timestamp, or null when the source did not report one. */
  modifiedAt: string | null
}

export type Side = 'left' | 'right'

/** Which column the listing is ordered by. `o` cycles through these. */
export type SortKey = 'name' | 'size' | 'time'

export const SORT_KEYS: readonly SortKey[] = ['name', 'size', 'time']

export type Pane = {
  label: string
  connection: Connection | null
  path: string
  entries: Entry[]
  /** Index into the *visible* entries, so filtering never selects a hidden row. */
  index: number
  offset: number
  error: string | null
  /** Live substring filter from the `/` prompt. */
  filter: string
  sort: SortKey
  descending: boolean
  showHidden: boolean
  loading: boolean
}

export function blankPane(label: string, path: string, connection: Connection | null = null): Pane {
  return {
    label,
    connection,
    path,
    entries: [],
    index: 0,
    offset: 0,
    error: null,
    filter: '',
    sort: 'name',
    descending: false,
    showHidden: false,
    loading: false,
  }
}

/** Somewhere a pane can point at: this machine, or a server. */
export type EndpointChoice = {
  label: string
  detail: string
  connection: Connection | null
  path: string
}

/**
 * Everywhere a pane can be pointed: this machine, then saved connections, then
 * `~/.ssh/config` hosts.
 *
 * Deduplicated by name, in that order of precedence — a saved connection wins
 * over an ssh_config host of the same name (it carries a port, a key and a
 * default path), and ssh_config itself can list one alias more than once.
 */
export function buildEndpointChoices(
  saved: readonly Connection[],
  sshHosts: readonly Connection[],
  localPath: string,
): EndpointChoice[] {
  const choices: EndpointChoice[] = [
    { label: 'Local', detail: 'this machine', connection: null, path: localPath },
    ...saved.map((connection) => ({
      label: connection.name,
      detail: `${connection.username}@${connection.host}`,
      connection,
      path: connection.defaultRemotePath ?? '.',
    })),
    ...sshHosts.map((connection) => ({
      label: connection.name,
      detail: `${connection.username}@${connection.host}  (ssh config)`,
      connection,
      path: '.',
    })),
  ]

  const seen = new Set<string>()
  return choices.filter((choice) => {
    if (seen.has(choice.label)) return false
    seen.add(choice.label)
    return true
  })
}

/** Case-insensitive substring match, which is what a `/` filter means here. */
export function matchesFilter(name: string, filter: string): boolean {
  if (filter === '') return true
  return name.toLowerCase().includes(filter.toLowerCase())
}

export function compareEntries(a: Entry, b: Entry, sort: SortKey, descending: boolean): number {
  // Directories stay on top whichever way the sort runs: they are how you move
  // around, not data, and burying them under a reversed size sort is useless.
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1

  let ordering: number
  if (sort === 'size') ordering = a.size - b.size
  else if (sort === 'time') ordering = (a.modifiedAt ?? '').localeCompare(b.modifiedAt ?? '')
  else ordering = 0

  // Name is the tiebreak for every sort, so equal sizes are not in listing order.
  if (ordering === 0) ordering = a.name.localeCompare(b.name)
  return descending ? -ordering : ordering
}

/** What the pane actually shows: hidden files, the filter and the sort applied. */
export function visibleEntries(pane: Pane): Entry[] {
  return pane.entries
    .filter((entry) => (pane.showHidden || !entry.name.startsWith('.')) && matchesFilter(entry.name, pane.filter))
    .sort((a, b) => compareEntries(a, b, pane.sort, pane.descending))
}

export function selectedEntry(pane: Pane): Entry | null {
  return visibleEntries(pane)[pane.index] ?? null
}

/** Keeps the cursor on a row that exists, which filtering and reloading can break. */
export function clampIndex(pane: Pane): void {
  const last = Math.max(0, visibleEntries(pane).length - 1)
  pane.index = Math.min(last, Math.max(0, pane.index))
}

export function listLocal(path: string): Entry[] {
  return readdirSync(path).map((name) => {
    const stats = statSync(join(path, name), { throwIfNoEntry: false })
    return {
      name,
      isDirectory: stats?.isDirectory() ?? false,
      size: stats?.size ?? 0,
      modifiedAt: stats ? stats.mtime.toISOString() : null,
    }
  })
}

export function defaultLocalPath(): string {
  return process.cwd() || homedir()
}

/** Short enough for a narrow column: `4.2M`, not `4.2 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`
  const units = ['K', 'M', 'G', 'T', 'P']
  let value = bytes
  let unit = -1
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[unit]}`
}

/**
 * A file date the way a file manager shows one: a clock for today, a day and
 * month for this year, a year for anything older.
 */
export function formatWhen(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad2 = (value: number) => String(value).padStart(2, '0')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (date.getFullYear() === now.getFullYear()) return `${months[date.getMonth()]} ${pad2(date.getDate())}`
  return `${months[date.getMonth()]} ${date.getFullYear()}`
}

/** Whatever is on screen instead of the panes, and owns the keyboard while it is. */
export type Overlay =
  | { kind: 'picker'; query: string; index: number }
  | { kind: 'help' }
  | { kind: 'hostKey'; host: string; fingerprint: string; keyType: string; decide: (trust: boolean) => void }

/** A transfer in flight, or the last one that ran. */
export type Transfer = {
  mode: 'preview' | 'sync'
  from: string
  to: string
  running: boolean
  progress: RsyncProgress | null
  /** Most recent paths rsync reported, newest last. Capped by `pushChange`. */
  recent: Change[]
  summary: ChangeSummary
  outcome: { ok: boolean; message: string } | null
  cancel: () => void
}

export const TRANSFER_LOG_LIMIT = 200

export function pushChange(transfer: Transfer, change: Change): void {
  transfer.summary[change.action] += 1
  transfer.recent.push(change)
  // The log panel shows a screenful; a million-file sync must not also hold a
  // million objects alive just to draw the last twenty of them.
  if (transfer.recent.length > TRANSFER_LOG_LIMIT) transfer.recent.splice(0, transfer.recent.length - TRANSFER_LOG_LIMIT)
}

/** Remaining seconds, derived from progress rather than rsync's own estimate. */
export function estimateRemaining(progress: RsyncProgress | null): number | null {
  if (!progress || progress.percent <= 0 || progress.percent >= 100 || progress.elapsedSeconds <= 0) return null
  return (progress.elapsedSeconds / progress.percent) * (100 - progress.percent)
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
