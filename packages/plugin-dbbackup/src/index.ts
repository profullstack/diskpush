/**
 * Database backups for DiskPush: dump Postgres, Supabase, MySQL/MariaDB and
 * SQLite to tagged, verified, gzipped files, keep a retention policy, push
 * them anywhere rsync reaches, and restore them.
 *
 * Surfaces:
 *   CLI      diskpush dbbackup add | list | remove | run | dump | backups | prune | verify | restore | cron | doctor
 *   TUI      `a` on a .sqlite/.db file (back it up) or on a backup (verify it)
 *   desktop  right-click the same; "Back up every database now" under Plugins…
 */
import { open, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import {
  definePlugin,
  type ActionResult,
  type BaseContext,
  type CommandContext,
  type DiskpushPlugin,
  type EntryRef,
} from '@diskpush/plugin-api'
import { redactUrl } from './engines.js'
import { KINDS, isValidName, parseBackupFileName, parseDays, parseTags, type Kind, type TagFilter } from './naming.js'
import {
  DEFAULT_BACKUP_DIR,
  backupDatabase,
  backupDir,
  checkConnection,
  doctor,
  formatBytes,
  inferKind,
  listBackups,
  loadDatabases,
  nameFromFile,
  pruneBackups,
  restoreBackup,
  retentionFor,
  saveDatabases,
  urlSecretKey,
  verifyBackup,
  type BackupReport,
  type DatabaseConfig,
  type ListedBackup,
} from './ops.js'

export * from './engines.js'
export * from './naming.js'
export * from './ops.js'
export { dumpToFile, rsyncPushArgs, sqliteToFile, verifyFile } from './runner.js'

const PACKAGE_VERSION: string = createRequire(import.meta.url)('../package.json').version

const SQLITE_FILE = /\.(sqlite3?|db3?|s3db)$/i

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when the file starts with SQLite's magic header, so a random `.db` is never "backed up". */
async function isSqliteFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return false
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0)
    return bytesRead === 16 && buffer.toString('latin1') === 'SQLite format 3\u0000'
  } finally {
    await handle.close()
  }
}

/**
 * A tiny argv reader: `--flag`, `--key value`, `--key=value`, repeatable keys,
 * and positionals. Unknown flags are an error, so a typo never silently does
 * the default thing to a database.
 */
export function parseArgs(args: readonly string[], spec: { values?: string[]; flags?: string[] }) {
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (spec.flags?.includes(key) && eq === -1) {
      flags.add(key)
    } else if (spec.values?.includes(key)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
      if (value === undefined) throw new UsageError(`--${key} needs a value.`)
      values.set(key, [...(values.get(key) ?? []), value])
    } else {
      throw new UsageError(`Unknown option --${key}.`)
    }
  }
  return {
    positional,
    flag: (key: string) => flags.has(key),
    value: (key: string) => values.get(key)?.at(-1),
    all: (key: string) => values.get(key) ?? [],
  }
}

class UsageError extends Error {}

function tagFilter(get: (key: string) => string | undefined): TagFilter {
  return { all: parseTags(get('tag')), any: parseTags(get('any')), none: parseTags(get('not')) }
}

function backupLine(backup: ListedBackup): string {
  const when = backup.at.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
  return `  ${backup.name.padEnd(20)} ${when}  ${formatBytes(backup.bytes).padStart(9)}  ${backup.tags.join(',') || '-'}`
}

function reportLine(report: BackupReport): string {
  if (!report.ok) return `✗ ${report.name}: ${report.error}`
  const extras = [
    report.pruned.length ? `pruned ${report.pruned.length}` : '',
    report.pushed ? `pushed to ${report.pushed}` : '',
  ].filter(Boolean)
  return `✓ ${report.name}: ${report.file} (${formatBytes(report.bytes ?? 0)})${extras.length ? ` · ${extras.join(' · ')}` : ''}`
}

async function runAll(ctx: BaseContext, names: readonly string[], options: Parameters<typeof backupDatabase>[2] = {}) {
  const all = await loadDatabases(ctx)
  const unknown = names.filter((name) => !all.some((db) => db.name === name))
  if (unknown.length) throw new UsageError(`No database named ${unknown.join(', ')}. See: diskpush dbbackup list`)
  const chosen = names.length ? all.filter((db) => names.includes(db.name)) : all
  if (!chosen.length) throw new UsageError('No databases saved yet. Add one: diskpush dbbackup add NAME --kind postgres')
  ctx.progress.start(chosen.length)
  const reports: BackupReport[] = []
  for (const db of chosen) {
    if (ctx.signal.aborted) break
    reports.push(await backupDatabase(ctx, db, options))
    ctx.progress.update({ done: reports.length, total: chosen.length })
  }
  return reports
}

/** A backup by file path, or a database name meaning its newest backup. */
async function findBackup(ctx: CommandContext, ref: string, tags: TagFilter): Promise<ListedBackup> {
  const parsed = parseBackupFileName(ref.split(/[\\/]/).pop() ?? '')
  if (parsed && (ref.includes('/') || ref.includes('\\'))) {
    const path = resolve(ctx.cwd, ref)
    return { ...parsed, path, bytes: 0 }
  }
  if (parsed) {
    const found = (await listBackups(ctx, { name: parsed.name })).find((b) => b.file === parsed.file)
    if (found) return found
    return { ...parsed, path: resolve(ctx.cwd, ref), bytes: 0 }
  }
  const [newest] = await listBackups(ctx, { name: ref, tags })
  if (!newest) throw new UsageError(`No backups of "${ref}"${tags.all?.length ? ` tagged ${tags.all.join(',')}` : ''}.`)
  return newest
}

export function createDbBackupPlugin(): DiskpushPlugin {
  const fail = (ctx: CommandContext, error: unknown) => {
    const message = describeError(error)
    if (ctx.json) ctx.printJson({ ok: false, message })
    else ctx.warn(message)
    return error instanceof UsageError ? 64 : 1
  }
  const done = (ctx: CommandContext, result: unknown, text: string | string[]) => {
    if (ctx.json) ctx.printJson(result)
    else for (const line of Array.isArray(text) ? text : [text]) ctx.print(line)
  }

  return definePlugin({
    id: 'dbbackup',
    name: 'Database backups',
    version: PACKAGE_VERSION,
    description: 'Back up Postgres, Supabase, MySQL/MariaDB and SQLite to tagged, verified, gzipped dumps; prune, push with rsync, restore.',
    settings: [
      { key: 'backupDir', label: 'Backup folder', type: 'string', default: '', description: `Where backups are written, one folder per database. Empty: ${DEFAULT_BACKUP_DIR}` },
      { key: 'keepLast', label: 'Keep newest', type: 'string', default: '7', description: 'How many backups of each database and tag set to keep.' },
      { key: 'keepDays', label: 'Also keep days', type: 'string', default: '0', description: 'Also keep every backup younger than this many days. 0 turns it off.' },
      { key: 'push', label: 'Push to', type: 'string', default: '', description: 'An rsync destination every backup is copied to, e.g. backup@nas:/srv/db. Empty: keep them local.' },
      { key: 'rsh', label: 'SSH command', type: 'string', default: '', description: 'The remote shell for pushes. Empty: ssh -o BatchMode=yes' },
      { key: 'pg_dumpPath', label: 'pg_dump path', type: 'string', default: '', description: 'Empty: the newest pg_dump installed.' },
      { key: 'mysqldumpPath', label: 'mysqldump path', type: 'string', default: '', description: 'Empty: mysqldump or mariadb-dump on PATH.' },
    ],
    async status(ctx) {
      const dbs = await loadDatabases(ctx)
      const [newest] = await listBackups(ctx)
      const count = `${dbs.length} database${dbs.length === 1 ? '' : 's'}`
      return newest ? `${count} · last backup ${newest.name} at ${newest.at.toISOString()}` : `${count} · no backups yet`
    },
    tasks: [
      {
        id: 'run-all',
        label: 'Back up every database now',
        async run(ctx) {
          try {
            const reports = await runAll(ctx, [])
            const failed = reports.filter((r) => !r.ok)
            return {
              ok: failed.length === 0,
              message: failed.length
                ? `${failed.length} of ${reports.length} failed: ${failed.map((r) => `${r.name} (${r.error})`).join('; ')}`
                : `Backed up ${reports.length} database${reports.length === 1 ? '' : 's'}.`,
            }
          } catch (error) {
            return { ok: false, message: describeError(error) }
          }
        },
      },
    ],
    actions: [
      {
        id: 'backup-sqlite',
        label: 'Back up SQLite database',
        description: 'A consistent, integrity-checked, gzipped copy in the backup folder.',
        tuiKey: 'b',
        appliesTo: (entries: readonly EntryRef[]) => entries.length > 0 && entries.every((e) => !e.isDirectory && SQLITE_FILE.test(e.name)),
        async run(ctx): Promise<ActionResult> {
          const saved = await loadDatabases(ctx)
          const lines: string[] = []
          let ok = true
          ctx.progress.start(ctx.names.length)
          for (const [index, file] of ctx.names.entries()) {
            const path = join(ctx.dir, file)
            if (!(await isSqliteFile(path))) {
              ok = false
              lines.push(`${file} is not a SQLite database`)
              continue
            }
            const db: DatabaseConfig = saved.find((d) => d.kind === 'sqlite' && d.path === path) ?? {
              name: nameFromFile(file),
              kind: 'sqlite',
              path,
              tags: ['manual'],
            }
            const report = await backupDatabase(ctx, db, { push: false })
            ok &&= report.ok
            lines.push(report.ok ? `${file} → ${report.path}` : `${file}: ${report.error}`)
            ctx.progress.update({ done: index + 1 })
          }
          return { ok, message: lines.join('; ') }
        },
      },
      {
        id: 'verify',
        label: 'Verify backup',
        description: 'Read the dump end to end: whole gzip, and the dump tool’s completion line.',
        tuiKey: 'v',
        appliesTo: (entries: readonly EntryRef[]) => entries.length > 0 && entries.every((e) => !e.isDirectory && parseBackupFileName(e.name) !== null),
        async run(ctx): Promise<ActionResult> {
          const bad: string[] = []
          for (const file of ctx.names) {
            try {
              await verifyBackup(join(ctx.dir, file), ctx.signal)
            } catch (error) {
              bad.push(`${file}: ${describeError(error)}`)
            }
          }
          return bad.length
            ? { ok: false, message: bad.join('; ') }
            : { ok: true, message: `${ctx.names.length} backup${ctx.names.length === 1 ? '' : 's'} OK.` }
        },
      },
    ],
    commands: [
      {
        name: 'add',
        summary: 'save a database to back up (the URL is asked for, and kept with your secrets)',
        usage: 'add NAME [--kind postgres|supabase|mysql|sqlite] [--url-env VAR | --path FILE] [--tags a,b] [--push DEST] [--keep-last N] [--keep-days D] [--dump-arg ARG]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['kind', 'url', 'url-env', 'path', 'tags', 'push', 'keep-last', 'keep-days', 'dump-arg'] })
            const [name] = a.positional
            if (!name || !isValidName(name)) throw new UsageError('usage: diskpush dbbackup add NAME --kind postgres  (NAME: lowercase letters, digits, _ and single dashes)')
            let url = a.value('url') ?? null
            const urlEnv = a.value('url-env')
            const path = a.value('path')
            let kind = (a.value('kind') ?? inferKind(url ?? path ?? (urlEnv ? (ctx.env[urlEnv] ?? '') : ''))) as Kind | null
            if (!kind || !KINDS.includes(kind)) throw new UsageError(`--kind must be one of ${KINDS.join(', ')}.`)
            const db: DatabaseConfig = { name, kind, tags: parseTags(a.value('tags')) }
            if (kind === 'sqlite') {
              if (!path) throw new UsageError('A SQLite database needs --path FILE.')
              db.path = resolve(ctx.cwd, path)
            } else if (urlEnv) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnv)) throw new UsageError(`${urlEnv} is not an environment variable name.`)
              db.urlEnv = urlEnv
              if (ctx.env[urlEnv]) checkConnection(kind, ctx.env[urlEnv]!)
            } else {
              // Asked for rather than taken from argv when it can be, so the password stays out of shell history and `ps`.
              if (url) ctx.warn('Note: a URL on the command line is visible in shell history. Omit --url to be asked for it.')
              url ??= (await ctx.prompt(`Connection URL for ${name} (${kind === 'mysql' ? 'mysql' : 'postgres'}://user:password@host/db): `))?.trim() ?? null
              if (!url) throw new UsageError('No connection URL. Pass --url-env VAR to read it from the environment instead.')
              checkConnection(kind, url)
            }
            if (a.value('push')) db.push = a.value('push')
            if (a.value('keep-last') !== undefined) db.keepLast = Number(a.value('keep-last'))
            if (a.value('keep-days') !== undefined) db.keepDays = parseDays(a.value('keep-days')!)
            if (a.all('dump-arg').length) db.dumpArgs = a.all('dump-arg')
            for (const n of [db.keepLast, db.keepDays]) if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new UsageError('--keep-last and --keep-days take a number of 0 or more.')
            const others = (await loadDatabases(ctx)).filter((d) => d.name !== name)
            await saveDatabases(ctx, [...others, db])
            if (url && !db.urlEnv) await ctx.secrets.set(urlSecretKey(name), url)
            else await ctx.secrets.set(urlSecretKey(name), null)
            done(ctx, { ok: true, database: db }, `Saved ${name} (${kind}). Back it up now with: diskpush dbbackup run ${name}`)
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'list',
        summary: 'the saved databases',
        usage: 'list',
        async run(_args, ctx) {
          const dbs = await loadDatabases(ctx)
          const rows = await Promise.all(
            dbs.map(async (db) => {
              const target = db.kind === 'sqlite' ? db.path : db.urlEnv ? `$${db.urlEnv}` : redactUrl((await ctx.secrets.get(urlSecretKey(db.name))) ?? '(no URL)')
              return { ...db, target, retention: await retentionFor(ctx, db) }
            }),
          )
          done(ctx, { databases: rows, backupDir: await backupDir(ctx) }, rows.length
            ? rows.map((r) => `  ${r.name.padEnd(20)} ${r.kind.padEnd(9)} ${r.target}${r.tags.length ? `  [${r.tags.join(',')}]` : ''}${r.push ? `  → ${r.push}` : ''}`)
            : 'No databases saved. Add one: diskpush dbbackup add NAME --kind postgres')
          return 0
        },
      },
      {
        name: 'remove',
        summary: 'forget a saved database (its backups stay unless --delete-backups)',
        usage: 'remove NAME [--delete-backups]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { flags: ['delete-backups'] })
            const [name] = a.positional
            const dbs = await loadDatabases(ctx)
            if (!name || !dbs.some((d) => d.name === name)) throw new UsageError(`No database named ${name ?? '(none)'}.`)
            await saveDatabases(ctx, dbs.filter((d) => d.name !== name))
            await ctx.secrets.set(urlSecretKey(name), null)
            let deleted = 0
            if (a.flag('delete-backups')) {
              for (const b of await listBackups(ctx, { name })) {
                await rm(b.path, { force: true })
                deleted += 1
              }
            }
            done(ctx, { ok: true, deleted }, `Removed ${name}${deleted ? ` and deleted ${deleted} backup${deleted === 1 ? '' : 's'}` : ''}.`)
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'run',
        summary: 'back up saved databases now (all of them, or the ones named), then prune and push',
        usage: 'run [NAME...] [--tags extra,tags] [--no-prune] [--no-push]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['tags'], flags: ['no-prune', 'no-push'] })
            const reports = await runAll(ctx, a.positional, {
              extraTags: parseTags(a.value('tags')),
              prune: !a.flag('no-prune'),
              push: !a.flag('no-push'),
            })
            const ok = reports.every((r) => r.ok)
            done(ctx, { ok, reports }, reports.map(reportLine))
            return ok ? 0 : 1
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'dump',
        summary: 'one backup of a database that is not saved: a SQLite path, or a URL from --url-env',
        usage: 'dump (FILE.sqlite | --url-env VAR) [--kind K] [--name NAME] [--tags a,b] [--out DIR]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['kind', 'url-env', 'name', 'tags', 'out'] })
            const urlEnv = a.value('url-env')
            const path = a.positional[0]
            const url = urlEnv ? ctx.env[urlEnv] : undefined
            if (urlEnv && !url) throw new UsageError(`The environment variable ${urlEnv} is not set.`)
            if (!url && !path) throw new UsageError('usage: diskpush dbbackup dump FILE.sqlite | --url-env VAR')
            const kind = (a.value('kind') ?? inferKind(url ?? path!)) as Kind | null
            if (!kind || !KINDS.includes(kind)) throw new UsageError(`Could not tell what kind of database that is. Pass --kind ${KINDS.join('|')}.`)
            if (url) checkConnection(kind, url)
            const name = a.value('name') ?? (kind === 'sqlite' ? nameFromFile(path!.split(/[\\/]/).pop()!) : nameFromFile(new URL(url!).pathname.slice(1) || 'db'))
            if (!isValidName(name)) throw new UsageError(`"${name}" is not a usable name.`)
            const db: DatabaseConfig = { name, kind, tags: parseTags(a.value('tags')) }
            if (kind === 'sqlite') db.path = resolve(ctx.cwd, path!)
            else db.urlEnv = urlEnv!
            const out = a.value('out')
            const scoped: BaseContext = out
              ? { ...ctx, settings: { get: async <T,>(key: string, fallback: T) => (key === 'backupDir' ? (resolve(ctx.cwd, out) as T) : ctx.settings.get(key, fallback)), set: ctx.settings.set } }
              : ctx
            const report = await backupDatabase(scoped, db, { prune: false, push: false })
            done(ctx, report, reportLine(report))
            return report.ok ? 0 : 1
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'backups',
        summary: 'list backups, newest first; --tag needs all, --any needs one, --not excludes',
        usage: 'backups [NAME] [--tag a,b] [--any a,b] [--not a,b]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['tag', 'any', 'not'] })
            const list = await listBackups(ctx, { ...(a.positional[0] ? { name: a.positional[0] } : {}), tags: tagFilter(a.value) })
            done(ctx, list.map((b) => ({ ...b, at: b.at.toISOString() })), list.length ? list.map(backupLine) : 'No backups.')
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'prune',
        summary: 'apply the retention policy now (each tag set separately; the newest is always kept)',
        usage: 'prune [NAME...] [--keep-last N] [--keep-days 30d] [--dry-run]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['keep-last', 'keep-days', 'older-than'], flags: ['dry-run'] })
            const dbs = await loadDatabases(ctx)
            const names = a.positional.length ? a.positional : [...new Set((await listBackups(ctx)).map((b) => b.name))]
            const removed: ListedBackup[] = []
            for (const name of names) {
              const policy = await retentionFor(ctx, dbs.find((d) => d.name === name))
              if (a.value('keep-last') !== undefined) policy.keepLast = Number(a.value('keep-last'))
              const days = a.value('keep-days') ?? a.value('older-than')
              if (days !== undefined) policy.keepDays = parseDays(days)
              removed.push(...(await pruneBackups(ctx, name, policy, { dryRun: a.flag('dry-run') })))
            }
            const verb = a.flag('dry-run') ? 'Would delete' : 'Deleted'
            done(ctx, { dryRun: a.flag('dry-run'), removed: removed.map((b) => b.path) }, removed.length ? [`${verb} ${removed.length}:`, ...removed.map(backupLine)] : 'Nothing to prune.')
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'verify',
        summary: 'read a backup end to end (a file, or NAME for its newest)',
        usage: 'verify FILE|NAME [--tag a,b]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['tag'] })
            const [ref] = a.positional
            if (!ref) throw new UsageError('usage: diskpush dbbackup verify FILE|NAME')
            const backup = await findBackup(ctx, ref, tagFilter(a.value))
            const { bytes } = await verifyBackup(backup.path, ctx.signal)
            done(ctx, { ok: true, path: backup.path, uncompressedBytes: bytes }, `OK ${backup.path} (${formatBytes(bytes)} uncompressed)`)
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'restore',
        summary: 'load a backup into a database (URL from --to-env, or a SQLite path with --to)',
        usage: 'restore FILE|NAME (--to-env VAR | --to PATH|URL) [--tag a,b] [--yes] [--continue-on-error] [--force]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['to', 'to-env', 'tag'], flags: ['yes', 'continue-on-error', 'force'] })
            const [ref] = a.positional
            const toEnv = a.value('to-env')
            const target = toEnv ? ctx.env[toEnv] : a.value('to')
            if (!ref || !target) throw new UsageError('usage: diskpush dbbackup restore FILE|NAME --to-env VAR | --to PATH')
            const backup = await findBackup(ctx, ref, tagFilter(a.value))
            await verifyBackup(backup.path, ctx.signal)
            const shown = backup.ext === 'sqlite.gz' ? resolve(target) : redactUrl(target)
            if (!a.flag('yes')) {
              const answer = await ctx.prompt(`Load ${backup.file} into ${shown}? Existing data there may be overwritten. Type "yes": `)
              if (answer === null) throw new UsageError('Pass --yes to restore without a terminal.')
              if (answer.trim().toLowerCase() !== 'yes') {
                done(ctx, { ok: false, message: 'Cancelled.' }, 'Cancelled.')
                return 1
              }
            }
            ctx.progress.update({ message: `Restoring ${backup.file}…` })
            await restoreBackup(ctx, backup, backup.ext === 'sqlite.gz' ? resolve(ctx.cwd, target) : target, {
              continueOnError: a.flag('continue-on-error'),
              force: a.flag('force'),
            })
            done(ctx, { ok: true, restored: backup.path, into: shown }, `Restored ${backup.file} into ${shown}.`)
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'cron',
        summary: 'print a crontab line that runs the backups on a schedule',
        usage: 'cron [NAME...] [--at "15 3 * * *"] [--tags nightly]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['at', 'tags'] })
            const at = a.value('at') ?? '15 3 * * *'
            if (at.trim().split(/\s+/).length !== 5) throw new UsageError('--at takes a five-field cron schedule, e.g. "15 3 * * *".')
            const tags = parseTags(a.value('tags') ?? 'scheduled')
            const names = a.positional.filter(isValidName)
            const command = ['diskpush', 'dbbackup', 'run', ...names, '--tags', tags.join(','), '--quiet'].join(' ')
            const line = `${at} mkdir -p "$HOME/.local/state" && ${command} >> "$HOME/.local/state/diskpush-dbbackup.log" 2>&1`
            done(ctx, { line }, [
              '# Add with: crontab -e',
              `PATH=${ctx.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
              line,
            ])
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'doctor',
        summary: 'which dump and restore tools this machine has',
        usage: 'doctor',
        async run(_args, ctx) {
          const tools = await doctor(ctx)
          done(ctx, { tools, backupDir: await backupDir(ctx) }, [
            ...tools.map((t) => `  ${t.path ? '✓' : '✗'} ${t.tool.padEnd(10)} ${t.path ?? t.hint}`),
            `  backups → ${await backupDir(ctx)}`,
          ])
          return 0
        },
      },
    ],
  })
}

export const dbBackupPlugin = createDbBackupPlugin()
export default dbBackupPlugin
