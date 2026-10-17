/**
 * Backup file names, tags, and retention.
 *
 * Everything about a backup is in its name, so a directory listing (local, on
 * a server, in a file browser) is the whole catalogue and no index can drift
 * out of step with the files:
 *
 *   <name>--<YYYYMMDDTHHMMSSZ>[--<tag>+<tag>].<ext>
 *   shop--20261017T030000Z--nightly+prod.sql.gz
 *
 * Names and tags are lowercase words joined by single dashes, so `--` only
 * ever separates fields and `+` only ever separates tags.
 */

export type Kind = 'postgres' | 'supabase' | 'mysql' | 'sqlite'
export const KINDS: readonly Kind[] = ['postgres', 'supabase', 'mysql', 'sqlite']

/** `.sql.gz` is a text dump any of the restore tools reads; `.sqlite.gz` is the database file itself. */
export type Extension = 'sql.gz' | 'sqlite.gz'

export const extensionFor = (kind: Kind): Extension => (kind === 'sqlite' ? 'sqlite.gz' : 'sql.gz')

const WORD_CHARS = /^[a-z0-9_-]+$/

/** Lowercase letters, digits, `_` and single dashes, not at either end; at most 64 characters. */
export function isValidName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    WORD_CHARS.test(value) &&
    !value.includes('--') &&
    !value.startsWith('-') &&
    !value.endsWith('-')
  )
}

export const isValidTag = isValidName

/** `"Nightly, prod"` → `['nightly', 'prod']`: lowercased, de-duplicated, sorted. Throws on a tag that cannot be in a name. */
export function parseTags(input: string | readonly string[] | undefined): string[] {
  const raw = typeof input === 'string' ? input.split(/[,+\s]+/) : [...(input ?? [])]
  const tags = new Set<string>()
  for (const item of raw) {
    const tag = item.trim().toLowerCase()
    if (!tag) continue
    if (!isValidTag(tag)) throw new Error(`"${item}" is not a usable tag: use letters, digits, _ and single dashes.`)
    tags.add(tag)
  }
  return [...tags].sort()
}

export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function parseStamp(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (!m) return null
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function backupFileName(name: string, at: Date, tags: readonly string[], ext: Extension): string {
  if (!isValidName(name)) throw new Error(`"${name}" is not a usable database name.`)
  const tagPart = tags.length ? `--${parseTags(tags).join('+')}` : ''
  return `${name}--${stamp(at)}${tagPart}.${ext}`
}

export type BackupFile = {
  file: string
  name: string
  at: Date
  tags: string[]
  ext: Extension
}

const EXTENSIONS: readonly Extension[] = ['sql.gz', 'sqlite.gz']

/** Null for anything this plugin did not name, which is therefore never pruned. */
export function parseBackupFileName(file: string): BackupFile | null {
  const ext = EXTENSIONS.find((candidate) => file.endsWith(`.${candidate}`))
  if (!ext) return null
  // Names and tags cannot contain `--`, so splitting on it recovers the fields exactly.
  const fields = file.slice(0, -(ext.length + 1)).split('--')
  if (fields.length < 2 || fields.length > 3) return null
  const [name, when, tagField] = fields as [string, string, string | undefined]
  if (!isValidName(name)) return null
  const at = parseStamp(when)
  if (!at) return null
  const tags = tagField === undefined ? [] : tagField.split('+')
  if (!tags.every(isValidTag)) return null
  return { file, name, at, tags, ext }
}

export type TagFilter = {
  /** Every one of these. */
  all?: readonly string[]
  /** At least one of these, when given. */
  any?: readonly string[]
  /** None of these. */
  none?: readonly string[]
}

export function matchesTags(tags: readonly string[], filter: TagFilter = {}): boolean {
  const has = new Set(tags)
  if (filter.all?.some((tag) => !has.has(tag))) return false
  if (filter.any?.length && !filter.any.some((tag) => has.has(tag))) return false
  if (filter.none?.some((tag) => has.has(tag))) return false
  return true
}

export type Retention = {
  /** Keep the newest N. 0 means the count alone keeps nothing. */
  keepLast: number
  /** Also keep anything younger than this many days. 0 turns it off. */
  keepDays: number
}

/**
 * Which backups to delete: those that are neither among the newest `keepLast`
 * nor younger than `keepDays`. The newest backup is always kept, whatever the
 * policy says, so a prune can never leave a database with no backup at all.
 */
export function selectForPrune(files: readonly BackupFile[], policy: Retention, now: Date = new Date()): BackupFile[] {
  const newestFirst = [...files].sort((a, b) => b.at.getTime() - a.at.getTime())
  const keepLast = Math.max(1, Math.floor(policy.keepLast))
  const cutoff = policy.keepDays > 0 ? now.getTime() - policy.keepDays * 86_400_000 : Number.POSITIVE_INFINITY
  return newestFirst.filter((file, index) => index >= keepLast && file.at.getTime() < cutoff)
}

/** `30d`, `12h`, `2w`, or a bare number of days. */
export function parseDays(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([hdw]?)$/i.exec(value.trim())
  if (!m) throw new Error(`"${value}" is not a duration: use e.g. 30d, 12h or 2w.`)
  const n = Number(m[1])
  const unit = (m[2] || 'd').toLowerCase()
  return unit === 'h' ? n / 24 : unit === 'w' ? n * 7 : n
}
