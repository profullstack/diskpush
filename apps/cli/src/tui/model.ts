/**
 * The state behind the two-pane browser, and the pure functions over it.
 *
 * Everything here is data: no terminal, no ssh, no rsync. The view renders a
 * snapshot of it and the app mutates it, which is what makes both testable
 * without a pty.
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
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
  /**
   * The listing of every directory that has been unfolded below the root, by
   * path relative to `path` (`src/lib`). Kept across a fold so unfolding again
   * is instant; dropped when the root changes.
   */
  children: Map<string, Entry[]>
  /** Relative paths of the directories currently unfolded. */
  unfolded: Set<string>
  /** Relative paths whose listing is on its way. */
  listing: Set<string>
  /** The row under the mouse, as an index into `visibleRows`; -1 is `..`. */
  hover: number | null
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
    children: new Map(),
    unfolded: new Set(),
    listing: new Set(),
    hover: null,
  }
}

/** Forgets everything below the root: the root is about to change. */
export function resetTree(pane: Pane): void {
  pane.children.clear()
  pane.unfolded.clear()
  pane.listing.clear()
  pane.hover = null
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

/** A listing with the pane's hidden-file rule, filter and sort applied. */
export function orderEntries(entries: readonly Entry[], pane: Pane): Entry[] {
  return entries
    .filter((entry) => (pane.showHidden || !entry.name.startsWith('.')) && matchesFilter(entry.name, pane.filter))
    .sort((a, b) => compareEntries(a, b, pane.sort, pane.descending))
}

/** The root listing as the pane shows it. */
export function visibleEntries(pane: Pane): Entry[] {
  return orderEntries(pane.entries, pane)
}

/** One line of a pane: an entry at some depth of the unfolded tree. */
export type Row = {
  entry: Entry
  /** Path relative to the pane root, e.g. `src/lib`. */
  rel: string
  depth: number
  unfolded: boolean
  /** The listing that would fill this directory is still on its way. */
  listing: boolean
  children: Row[]
}

/** The pane as a tree: the root listing, with each unfolded directory's listing nested under it. */
export function rowTree(pane: Pane): Row[] {
  const build = (entries: readonly Entry[], prefix: string, depth: number): Row[] =>
    orderEntries(entries, pane).map((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const unfolded = entry.isDirectory && pane.unfolded.has(rel)
      return {
        entry,
        rel,
        depth,
        unfolded,
        listing: pane.listing.has(rel),
        children: unfolded ? build(pane.children.get(rel) ?? [], rel, depth + 1) : [],
      }
    })
  return build(pane.entries, '', 0)
}

/**
 * The tree flattened in the order it is drawn, which is what the cursor
 * indexes and what a click lands on.
 */
export function visibleRows(pane: Pane): Row[] {
  const out: Row[] = []
  const walk = (rows: Row[]): void => {
    for (const row of rows) {
      out.push(row)
      walk(row.children)
    }
  }
  walk(rowTree(pane))
  return out
}

export function selectedRow(pane: Pane): Row | null {
  return visibleRows(pane)[pane.index] ?? null
}

export function selectedEntry(pane: Pane): Entry | null {
  return selectedRow(pane)?.entry ?? null
}


/** The directory above this pane's, or null when there is nowhere up to go. */
export function parentPath(pane: Pane): string | null {
  const parent = pane.connection ? posix.dirname(pane.path) : join(pane.path, '..')
  return parent === pane.path ? null : parent
}

/** Keeps the cursor on a row that exists, which filtering, folding and reloading can break. */
export function clampIndex(pane: Pane): void {
  const last = Math.max(0, visibleRows(pane).length - 1)
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
  /** What is being synced, for a person: `src/lib`, `README.md`, or `everything`. */
  what: string
  running: boolean
  /** `Date.now()` when rsync was started, so the clock ticks without rsync saying anything. */
  startedAt: number
  /** `Date.now()` when it stopped, however it stopped; null while running. */
  endedAt: number | null
  progress: RsyncProgress | null
  /**
   * Files rsync has checked against the other side, out of the total it
   * found. This is the number that moves during a preview, where the byte
   * percentage is zero by definition: a dry run transfers nothing.
   */
  scanned: { checked: number; total: number } | null
  /** Most recent paths rsync reported, newest last. Capped by `pushChange`. */
  recent: Change[]
  summary: ChangeSummary
  outcome: { ok: boolean; message: string; cancelled?: boolean } | null
  cancel: () => void
}

/** True when a finished preview found nothing that a sync would change. */
export function nothingToDo(transfer: Transfer): boolean {
  const { add, update, metadata, delete: removed, error } = transfer.summary
  return transfer.outcome?.ok === true && add + update + metadata + removed + error === 0
}

/** Files checked from rsync's `to-chk=remaining/total`, once it has said. */
export function scannedFrom(progress: RsyncProgress): { checked: number; total: number } | null {
  if (progress.filesTotal === null || progress.filesRemaining === null) return null
  return { checked: Math.max(0, progress.filesTotal - progress.filesRemaining), total: progress.filesTotal }
}

/** An rsync endpoint for a path under the pane: `user@host:/srv/app/src/` or `/home/me/src/`. */
export function endpointString(pane: Pane, rel = '', isDirectory = true): string {
  const joined = pane.connection ? posix.join(pane.path, rel) : join(pane.path, rel)
  const path = isDirectory && !joined.endsWith('/') ? `${joined}/` : joined
  if (!pane.connection) return path
  return `${pane.connection.username}@${pane.connection.host}:${path}`
}

export type TransferScope = { from: string; to: string; what: string }

/**
 * What a preview or sync covers: the row under the cursor, mirrored to the
 * same relative path in the other pane, so the two trees stay aligned. A
 * directory goes to the directory of the same name; a file goes into the
 * directory that holds it. With nothing under the cursor, the whole pane.
 */
export function scopeTransfer(source: Pane, destination: Pane): TransferScope {
  const row = selectedRow(source)
  if (!row) return { from: endpointString(source), to: endpointString(destination), what: 'everything' }
  if (row.entry.isDirectory) {
    return { from: endpointString(source, row.rel), to: endpointString(destination, row.rel), what: row.rel }
  }
  const parent = dirname(row.rel)
  return {
    from: endpointString(source, row.rel, false),
    to: endpointString(destination, parent === '.' ? '' : parent),
    what: row.rel,
  }
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

// ---------------------------------------------------------------- documents

/**
 * How much of a file the viewer reads: the first megabyte.
 *
 * Every document anyone reads in a terminal fits; the cap is for what else is
 * under a cursor in a file manager — an archive, a database, a video — where
 * reading the whole thing would take minutes and show nothing anyway.
 */
export const DOCUMENT_LIMIT = 1024 * 1024

/**
 * An image is read whole, up to this, because the terminal is handed the file
 * itself and half a PNG draws nothing. Eight megabytes covers a photo; a
 * scan or a poster past it shows as a hex dump with the way out spelled.
 */
export const IMAGE_LIMIT = 8 * 1024 * 1024

/** How a document is drawn: rendered markdown, plain lines, an image, or a hex dump. */
export type DocumentKind = 'markdown' | 'text' | 'image' | 'binary'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'

/** What the header of an image file says about it. */
export type ImageInfo = { format: ImageFormat; width: number; height: number }

/** Files that are worth reading whole, because they are drawn rather than dumped. */
export function isImageName(name: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(name)
}

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length && Buffer.from(bytes.subarray(at, at + text.length)).toString('latin1') === text

/**
 * The format and pixel size of an image, from its header alone.
 *
 * Nothing is decoded: each format writes its dimensions near the top, and
 * that is what the viewer needs to size the box the terminal draws into and
 * to say `PNG 2172×724` in the footer. A file whose header fits none of them
 * is not an image, whatever its name.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (ascii(bytes, 1, 'PNG') && bytes[0] === 0x89 && bytes.length >= 24) {
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (ascii(bytes, 0, 'GIF8') && bytes.length >= 10) {
    return { format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (ascii(bytes, 0, 'BM') && bytes.length >= 26) {
    return { format: 'bmp', width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) }
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP') && bytes.length >= 30) {
    const chunk = Buffer.from(bytes.subarray(12, 16)).toString('latin1')
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return { format: 'webp', width, height }
    }
    if (chunk === 'VP8 ') return { format: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true)
      return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
    return null
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the markers to the first start-of-frame, which carries the size.
    let at = 2
    while (at + 9 < bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1]!
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2
        continue
      }
      const length = view.getUint16(at + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
      }
      at += 2 + length
    }
    return null
  }
  return null
}

/** A file open under the panes. */
export type Document = {
  /** The pane it was opened from. */
  side: Side
  name: string
  /** Where it is, spelled the way a transfer would: `user@host:/srv/app/README.md` or `/home/me/README.md`. */
  location: string
  /** The head is still on its way. */
  loading: boolean
  error: string | null
  kind: DocumentKind
  /** Format and pixel size, for an image. */
  image: ImageInfo | null
  /** Decoded text for markdown and text; empty for a binary. */
  text: string
  /** The raw head, kept for the hex view. */
  bytes: Uint8Array
  /** The whole file's size, which can be far more than was read. */
  size: number
  /** First rendered line on screen. */
  scroll: number
}

export function blankDocument(side: Side, name: string, location: string): Document {
  return {
    side,
    name,
    location,
    loading: true,
    error: null,
    kind: 'text',
    image: null,
    text: '',
    bytes: new Uint8Array(),
    size: 0,
    scroll: 0,
  }
}

/** True when more of the file exists than the viewer read. */
export function isTruncated(doc: Document): boolean {
  return doc.size > doc.bytes.length
}

/** What readm3 opens: the markdown extensions, matched the way it matches them. */
const MARKDOWN_NAME = /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdx)$/i

export function isMarkdownName(name: string): boolean {
  return MARKDOWN_NAME.test(name)
}

/** How many leading bytes decide text against binary. */
const SNIFF = 8192

const utf8 = new TextDecoder('utf-8', { fatal: false })

/**
 * A NUL in the head is the test `grep` and `git` use, and it is right far more
 * often than any cleverer one: text encodings do not emit NUL, and nearly every
 * binary format does within its first few kilobytes.
 *
 * Not every one, though. Three hundred random bytes have a one-in-three chance
 * of holding no NUL at all, and a small compressed or encrypted file shown as
 * "text" is a panel of garbage. So beyond NUL, a head is binary when a tenth
 * of it is either a control byte that is not whitespace or a byte that is not
 * UTF-8 — the decoder's replacement characters count those. A Latin-1 file
 * with an accent every few words stays text; noise does not.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, SNIFF)
  if (head.length === 0) return false
  let suspect = 0
  for (const byte of head) {
    if (byte === 0) return true
    // Tab, newline, carriage return, form feed and escape are text.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) suspect += 1
  }
  for (const char of utf8.decode(head)) if (char === '\ufffd') suspect += 1
  return suspect / head.length > 0.1
}

/** Bytes as text: UTF-8, a BOM dropped, Windows line ends folded. */
export function decodeText(bytes: Uint8Array): string {
  const text = utf8.decode(bytes)
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n')
}

/** Bytes per row of the hex view. */
export const HEX_ROW = 16

/**
 * A hex dump of the head, one row per sixteen bytes: offset, the bytes, and
 * the printable ones as characters. `xxd` without the `xxd`.
 */
export function hexDump(bytes: Uint8Array, limit = 4096): string[] {
  const rows: string[] = []
  const end = Math.min(bytes.length, limit)
  for (let at = 0; at < end; at += HEX_ROW) {
    const chunk = bytes.subarray(at, Math.min(at + HEX_ROW, end))
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0'))
    // A gap after the eighth byte, as every hex dump since `od` has drawn it.
    const left = hex.slice(0, 8).join(' ')
    const right = hex.slice(8).join(' ')
    const ascii = [...chunk].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('')
    rows.push(`${at.toString(16).padStart(8, '0')}  ${(left + '  ' + right).padEnd(HEX_ROW * 3 + 1)} |${ascii}|`)
  }
  return rows
}

/**
 * Fills a document in from the head that was read for it.
 *
 * `markdownByContent` is a second opinion for a file whose name says nothing
 * — `README`, `NOTES`, a file with no extension — so the kind is decided by
 * the name first and by the text only when the name is silent.
 */
export function fillDocument(
  doc: Document,
  head: { bytes: Uint8Array; size: number },
  markdownByContent: (text: string) => boolean = () => false,
): void {
  doc.bytes = head.bytes
  doc.size = head.size
  doc.loading = false
  doc.error = null
  doc.scroll = 0
  doc.image = null
  if (looksBinary(head.bytes)) {
    // An image the terminal can be handed whole is drawn; one cut short by
    // the read limit is a hex dump like any other binary.
    const info = imageInfo(head.bytes)
    doc.kind = info && head.size === head.bytes.length ? 'image' : 'binary'
    doc.image = doc.kind === 'image' ? info : null
    doc.text = ''
    return
  }
  doc.text = decodeText(head.bytes)
  doc.kind =
    isMarkdownName(doc.name) || (!doc.name.includes('.') && markdownByContent(doc.text)) ? 'markdown' : 'text'
}

/** The first `limit` bytes of a local file, and how big the whole file is. */
export function readLocalHead(path: string, limit: number): { bytes: Uint8Array; size: number } {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const bytes = Buffer.alloc(Math.max(0, Math.min(size, limit)))
    let read = 0
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read)
      if (count === 0) break
      read += count
    }
    return { bytes: bytes.subarray(0, read), size }
  } finally {
    closeSync(fd)
  }
}
