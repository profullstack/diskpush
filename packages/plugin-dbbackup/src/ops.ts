/**
 * What the plugin does, independent of which surface asked: the saved list of
 * databases, and backing one up, listing, pruning, pushing and restoring.
 *
 * Connection URLs carry passwords, so they live in the plugin's secrets, never
 * its settings; or nowhere at all when a database names an environment
 * variable to read the URL from (`--url-env`), which is the way to keep them
 * in a vault and out of DiskPush.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BaseContext } from '@diskpush/plugin-api'
import {
  INSTALL_HINT,
  TRAILERS,
  findTool,
  mysqlRestoreInvocation,
  mysqldumpInvocation,
  parseMysqlUrl,
  parsePostgresUrl,
  pgDumpInvocation,
  psqlInvocation,
  type Tool,
} from './engines.js'
import {
  backupFileName,
  extensionFor,
  isValidName,
  matchesTags,
  parseBackupFileName,
  parseTags,
  selectForPrune,
  type BackupFile,
  type Kind,
  type Retention,
  type TagFilter,
} from './naming.js'
import { dumpToFile, gunzipStream, restoreSqliteFile, rsyncPushArgs, run, sqliteToFile, verifyFile, type DumpResult } from './runner.js'

export type DatabaseConfig = {
  name: string
  kind: Kind
  /** SQLite: the database file. */
  path?: string
  /** Read the connection URL from this environment variable instead of the stored secret. */
  urlEnv?: string
  tags: string[]
  /** An rsync destination (`backup@nas:/srv/backups`, `/mnt/usb/db`) each backup is pushed to. */
  push?: string
  keepLast?: number
  keepDays?: number
  /** Appended to the dump tool's argv, e.g. `--exclude-table=audit_log`. */
  dumpArgs?: string[]
}

export const DEFAULT_BACKUP_DIR = join(homedir(), 'Backups', 'diskpush')
export const DEFAULT_RETENTION: Retention = { keepLast: 7, keepDays: 0 }

export const urlSecretKey = (name: string) => `url:${name}`

export async function loadDatabases(ctx: BaseContext): Promise<DatabaseConfig[]> {
  const list = await ctx.settings.get<unknown>('databases', [])
  return Array.isArray(list) ? (list as DatabaseConfig[]).filter((db) => db && isValidName(db.name)) : []
}

export async function saveDatabases(ctx: BaseContext, list: readonly DatabaseConfig[]): Promise<void> {
  await ctx.settings.set('databases', [...list].sort((a, b) => a.name.localeCompare(b.name)))
}

export async function backupDir(ctx: BaseContext): Promise<string> {
  const configured = (await ctx.settings.get<string>('backupDir', '')).trim()
  if (!configured) return DEFAULT_BACKUP_DIR
  return resolve(configured.replace(/^~(?=$|[\\/])/, homedir()))
}

async function numberSetting(ctx: BaseContext, key: string, fallback: number): Promise<number> {
  const raw = await ctx.settings.get<unknown>(key, '')
  const n = Number(raw)
  return raw === '' || raw === null || !Number.isFinite(n) || n < 0 ? fallback : n
}

export async function retentionFor(ctx: BaseContext, db?: DatabaseConfig): Promise<Retention> {
  return {
    keepLast: db?.keepLast ?? (await numberSetting(ctx, 'keepLast', DEFAULT_RETENTION.keepLast)),
    keepDays: db?.keepDays ?? (await numberSetting(ctx, 'keepDays', DEFAULT_RETENTION.keepDays)),
  }
}

/** Guesses the kind from a URL or a path: `postgres://…supabase.co` is Supabase. */
export function inferKind(target: string): Kind | null {
  if (/^postgres(ql)?:\/\//i.test(target)) return /supabase\.(co|com)\b/i.test(target) ? 'supabase' : 'postgres'
  if (/^(mysql|mariadb):\/\//i.test(target)) return 'mysql'
  if (/\.(sqlite3?|db3?|s3db)$/i.test(target)) return 'sqlite'
  return null
}

/** Throws when `url` cannot be used for `kind`; the message names what is wrong. */
export function checkConnection(kind: Kind, url: string): void {
  if (kind === 'postgres' || kind === 'supabase') parsePostgresUrl(url)
  else if (kind === 'mysql') parseMysqlUrl(url)
}

export async function connectionUrl(ctx: BaseContext, db: DatabaseConfig): Promise<string> {
  if (db.urlEnv) {
    const value = ctx.env[db.urlEnv]
    if (!value) throw new Error(`${db.name}: the environment variable ${db.urlEnv} is not set.`)
    return value
  }
  const stored = await ctx.secrets.get(urlSecretKey(db.name))
  if (!stored) throw new Error(`${db.name}: no connection URL saved. Run: diskpush dbbackup add ${db.name} --kind ${db.kind}`)
  return stored
}

async function toolPath(ctx: BaseContext, tool: Tool): Promise<string> {
  const override = (await ctx.settings.get<string>(`${tool}Path`, '')).trim() || null
  const found = findTool(tool, ctx.env, override)
  if (!found) throw new Error(`${tool} was not found${override ? ` at ${override}` : ' on PATH'}. ${INSTALL_HINT[tool]}`)
  return found
}

export type BackupReport = {
  name: string
  ok: boolean
  file?: string
  path?: string
  bytes?: number
  pruned: string[]
  pushed?: string
  error?: string
}

/** One backup of one database: dump, prune the same tag set, push. Never throws; the report says. */
export async function backupDatabase(
  ctx: BaseContext,
  db: DatabaseConfig,
  options: { extraTags?: readonly string[]; prune?: boolean; push?: boolean; now?: Date } = {},
): Promise<BackupReport> {
  const report: BackupReport = { name: db.name, ok: false, pruned: [] }
  try {
    const tags = parseTags([...db.tags, ...(options.extraTags ?? [])])
    const file = backupFileName(db.name, options.now ?? new Date(), tags, extensionFor(db.kind))
    const dir = join(await backupDir(ctx), db.name)
    const final = join(dir, file)
    ctx.progress.update({ message: `Backing up ${db.name} (${db.kind})…`, currentFile: file })
    let result: DumpResult
    if (db.kind === 'sqlite') {
      if (!db.path) throw new Error(`${db.name}: no SQLite file configured.`)
      const sqlite3 = findTool('sqlite3', ctx.env, (await ctx.settings.get<string>('sqlite3Path', '')).trim() || null)
      result = await sqliteToFile({ source: db.path, final, sqlite3, env: ctx.env, signal: ctx.signal })
    } else {
      const url = await connectionUrl(ctx, db)
      const invocation =
        db.kind === 'mysql' ? mysqldumpInvocation(url, db.dumpArgs) : pgDumpInvocation(db.kind, url, db.dumpArgs)
      const program = await toolPath(ctx, db.kind === 'mysql' ? 'mysqldump' : 'pg_dump')
      result = await dumpToFile({
        program,
        args: invocation.args,
        extraEnv: invocation.env,
        env: ctx.env,
        signal: ctx.signal,
        final,
        trailer: TRAILERS[db.kind],
      })
    }
    Object.assign(report, { ok: true, file, path: result.path, bytes: result.bytes })
    ctx.progress.log('info', `${db.name}: wrote ${file} (${formatBytes(result.bytes)})`)

    if (options.prune !== false) {
      const sameSet = (b: BackupFile) => b.tags.join('+') === tags.join('+')
      const pruned = await pruneBackups(ctx, db.name, await retentionFor(ctx, db), { filter: sameSet })
      report.pruned = pruned.map((b) => b.file)
    }
    const destination = db.push ?? ((await ctx.settings.get<string>('push', '')).trim() || undefined)
    if (options.push !== false && destination) {
      ctx.progress.update({ message: `Pushing ${db.name} to ${destination}…` })
      await pushBackups(ctx, db.name, destination)
      report.pushed = destination
    }
  } catch (error) {
    report.ok = false
    report.error = error instanceof Error ? error.message : String(error)
    ctx.progress.log('error', `${db.name}: ${report.error}`)
  }
  return report
}

export type ListedBackup = BackupFile & { path: string; bytes: number }

/** Every backup this plugin named, newest first, under the backup directory (one folder per database). */
export async function listBackups(ctx: BaseContext, options: { name?: string; tags?: TagFilter } = {}): Promise<ListedBackup[]> {
  const root = await backupDir(ctx)
  let folders: string[]
  try {
    folders = options.name ? [options.name] : await readdir(root)
  } catch {
    return []
  }
  const out: ListedBackup[] = []
  for (const folder of folders) {
    let files: string[]
    try {
      files = await readdir(join(root, folder))
    } catch {
      continue
    }
    for (const file of files) {
      const parsed = parseBackupFileName(file)
      if (!parsed || parsed.name !== folder || !matchesTags(parsed.tags, options.tags)) continue
      const path = join(root, folder, file)
      try {
        out.push({ ...parsed, path, bytes: (await stat(path)).size })
      } catch {
        // Removed since the listing.
      }
    }
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime() || a.name.localeCompare(b.name))
}

/**
 * Applies a retention policy to one database's backups. Each distinct tag set
 * is its own series (nightly and monthly never prune each other), and a
 * series always keeps its newest backup.
 */
export async function pruneBackups(
  ctx: BaseContext,
  name: string,
  policy: Retention,
  options: { filter?: (b: BackupFile) => boolean; dryRun?: boolean; now?: Date } = {},
): Promise<ListedBackup[]> {
  const all = (await listBackups(ctx, { name })).filter(options.filter ?? (() => true))
  const series = new Map<string, ListedBackup[]>()
  for (const backup of all) {
    const key = backup.tags.join('+')
    series.set(key, [...(series.get(key) ?? []), backup])
  }
  const doomed: ListedBackup[] = []
  for (const files of series.values()) doomed.push(...(selectForPrune(files, policy, options.now) as ListedBackup[]))
  if (!options.dryRun) {
    for (const backup of doomed) {
      await rm(backup.path, { force: true })
      ctx.progress.log('info', `${name}: pruned ${backup.file}`)
    }
  }
  return doomed
}

export async function pushBackups(ctx: BaseContext, name: string, destination: string): Promise<void> {
  const rsh = (await ctx.settings.get<string>('rsh', '')).trim() || 'ssh -o BatchMode=yes'
  const rsync = findTool('rsync', ctx.env) ?? 'rsync'
  await run({
    program: rsync,
    args: rsyncPushArgs(join(await backupDir(ctx), name), destination, name, rsh),
    env: ctx.env,
    signal: ctx.signal,
  })
}

export function trailersFor(backup: Pick<BackupFile, 'ext'>): string[] | null {
  return backup.ext === 'sql.gz' ? [...new Set(Object.values(TRAILERS))] : null
}

export async function verifyBackup(path: string, signal?: AbortSignal): Promise<{ bytes: number }> {
  const parsed = parseBackupFileName(path.split(/[\\/]/).pop() ?? '')
  return verifyFile(path, parsed ? trailersFor(parsed) : null, signal)
}

/**
 * Loads a backup into `target`: a connection URL for a SQL dump, a file path
 * for SQLite. A SQL dump's kind is the configured database's when known,
 * otherwise read from the target URL.
 */
export async function restoreBackup(
  ctx: BaseContext,
  backup: BackupFile & { path: string },
  target: string,
  options: { continueOnError?: boolean; force?: boolean } = {},
): Promise<void> {
  if (backup.ext === 'sqlite.gz') {
    const path = resolve(target)
    if (!options.force) {
      const exists = await stat(path).then(() => true, () => false)
      if (exists) throw new Error(`${path} exists. Pass --force to replace it.`)
    }
    await restoreSqliteFile(backup.path, path)
    return
  }
  const kind = inferKind(target)
  if (kind === 'mysql') {
    const invocation = mysqlRestoreInvocation(target)
    await run({ program: await toolPath(ctx, 'mysql'), args: invocation.args, extraEnv: invocation.env, env: ctx.env, signal: ctx.signal, stdin: gunzipStream(backup.path) })
  } else if (kind === 'postgres' || kind === 'supabase') {
    const invocation = psqlInvocation(target, options.continueOnError)
    await run({ program: await toolPath(ctx, 'psql'), args: invocation.args, extraEnv: invocation.env, env: ctx.env, signal: ctx.signal, stdin: gunzipStream(backup.path) })
  } else {
    throw new Error('Restore a SQL dump into a postgres:// or mysql:// URL.')
  }
}

export type ToolStatus = { tool: string; path: string | null; hint?: string }

export async function doctor(ctx: BaseContext): Promise<ToolStatus[]> {
  const tools: Tool[] = ['pg_dump', 'psql', 'mysqldump', 'mysql', 'sqlite3', 'rsync']
  const out: ToolStatus[] = []
  for (const tool of tools) {
    const path = findTool(tool, ctx.env, (await ctx.settings.get<string>(`${tool}Path`, '')).trim() || null)
    out.push(path ? { tool, path } : { tool, path, hint: INSTALL_HINT[tool] })
  }
  return out
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** A database name from a file name: `My App.sqlite3` → `my-app`. */
export function nameFromFile(file: string): string {
  const stem = file.replace(/\.(sqlite3?|db3?|s3db)$/i, '')
  const name = stem
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return name || 'sqlite'
}
