import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PluginRegistry, memoryBackend, runAction, runTask, silentProgress, type CommandContext, type LogLevel } from '@diskpush/plugin-api'
import {
  SUPABASE_EXCLUDED_SCHEMAS,
  backupFileName,
  createDbBackupPlugin,
  inferKind,
  matchesTags,
  mysqldumpInvocation,
  nameFromFile,
  parseArgs,
  parseBackupFileName,
  parseDays,
  parseTags,
  pgDumpInvocation,
  psqlInvocation,
  redactUrl,
  rsyncPushArgs,
  selectForPrune,
  sqliteToFile,
  type BackupFile,
} from './index.js'

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `dp-db-${prefix}-`))

/**
 * Stand-ins for pg_dump and psql: shell scripts that record their argv and
 * the password they were handed, then behave like the real tool.
 */
function fakeTools(): { bin: string; log: string } {
  const bin = temp('bin')
  const log = join(bin, 'log')
  mkdirSync(log)
  const pgDump = `#!/bin/sh
printf '%s\\n' "$@" > "${log}/pg_dump.args"
printf '%s' "$PGPASSWORD" > "${log}/pg_dump.password"
if [ -n "$FAKE_FAIL" ]; then echo "pg_dump: error: connection refused" >&2; exit 1; fi
echo "-- PostgreSQL database dump"
echo "CREATE TABLE t (id int);"
echo "COPY t (id) FROM stdin;"
i=0; while [ $i -lt 2000 ]; do echo "$i"; i=$((i+1)); done
echo "\\\\."
if [ -z "$FAKE_TRUNCATE" ]; then echo "-- PostgreSQL database dump complete"; fi
`
  const psql = `#!/bin/sh
printf '%s\\n' "$@" > "${log}/psql.args"
printf '%s' "$PGPASSWORD" > "${log}/psql.password"
cat > "${log}/psql.stdin"
`
  writeFileSync(join(bin, 'pg_dump'), pgDump)
  writeFileSync(join(bin, 'psql'), psql)
  chmodSync(join(bin, 'pg_dump'), 0o755)
  chmodSync(join(bin, 'psql'), 0o755)
  return { bin, log }
}

async function setup(env: Record<string, string> = {}) {
  const registry = new PluginRegistry(memoryBackend())
  registry.register(createDbBackupPlugin())
  const tools = fakeTools()
  const backups = temp('backups')
  const settings = registry.settingsFor('dbbackup')
  await settings.set('backupDir', backups)
  await settings.set('pg_dumpPath', join(tools.bin, 'pg_dump'))
  await settings.set('psqlPath', join(tools.bin, 'psql'))
  const logs: { level: LogLevel; message: string }[] = []
  const fullEnv = { PATH: process.env.PATH, ...env }
  const host = () => ({
    progress: { ...silentProgress, log: (level: LogLevel, message: string) => logs.push({ level, message }) },
    openUrl: async () => {},
    signal: new AbortController().signal,
    surface: 'desktop' as const,
    env: fullEnv,
  })
  /** Runs `diskpush dbbackup <args>` and captures what it printed. */
  const cli = async (args: string[], answers: string[] = []) => {
    const out: string[] = []
    const err: string[] = []
    let json: unknown
    const isJson = args.includes('--json')
    const ctx: CommandContext = {
      ...host(),
      settings,
      secrets: registry.secretsFor('dbbackup'),
      surface: 'cli',
      cwd: backups,
      json: isJson,
      print: (text) => out.push(text),
      warn: (text) => err.push(text),
      printJson: (value) => (json = value),
      prompt: async () => answers.shift() ?? null,
    }
    const [name, ...rest] = args.filter((a) => a !== '--json')
    const { command } = await registry.command('dbbackup', name!)
    const code = await command!.run(rest, ctx)
    return { code, out: out.join('\n'), err: err.join('\n'), json }
  }
  return { registry, tools, backups, logs, host, cli, settings }
}

describe('file names', () => {
  it('round-trips name, time and sorted tags', () => {
    const at = new Date('2026-10-17T03:15:00Z')
    const file = backupFileName('shop-db', at, ['prod', 'nightly'], 'sql.gz')
    expect(file).toBe('shop-db--20261017T031500Z--nightly+prod.sql.gz')
    expect(parseBackupFileName(file)).toEqual({ file, name: 'shop-db', at, tags: ['nightly', 'prod'], ext: 'sql.gz' })
    expect(parseBackupFileName('shop-db--20261017T031500Z.sqlite.gz')?.tags).toEqual([])
  })

  it('never claims a file it did not name', () => {
    for (const file of ['notes.sql.gz', 'shop--2026-10-17.sql.gz', 'shop--20261017T031500Z.sql', '.shop--20261017T031500Z.sql.gz.partial']) {
      expect(parseBackupFileName(file)).toBeNull()
    }
  })

  it('refuses names and tags that would break the format', () => {
    expect(() => backupFileName('a--b', new Date(), [], 'sql.gz')).toThrow()
    expect(() => parseTags('ok, not ok')).not.toThrow()
    expect(parseTags('Nightly, prod,nightly')).toEqual(['nightly', 'prod'])
    expect(parseTags('a+b')).toEqual(['a', 'b'])
    expect(() => parseTags(['a+b'])).toThrow(/not a usable tag/)
    expect(() => parseTags(['a/b'])).toThrow(/not a usable tag/)
  })

  it('derives a name from a SQLite file name', () => {
    expect(nameFromFile('My App.sqlite3')).toBe('my-app')
    expect(nameFromFile('...db')).toBe('sqlite')
  })
})

describe('tag filters and retention', () => {
  it('matches all / any / none', () => {
    expect(matchesTags(['nightly', 'prod'], { all: ['prod'] })).toBe(true)
    expect(matchesTags(['nightly', 'prod'], { all: ['prod', 'eu'] })).toBe(false)
    expect(matchesTags(['nightly'], { any: ['weekly', 'nightly'] })).toBe(true)
    expect(matchesTags(['nightly', 'test'], { none: ['test'] })).toBe(false)
  })

  const series = (days: number[]): BackupFile[] =>
    days.map((d) => ({ file: `x${d}`, name: 'x', at: new Date(Date.UTC(2026, 9, 17) - d * 86_400_000), tags: [], ext: 'sql.gz' }))
  const now = new Date(Date.UTC(2026, 9, 17, 1))

  it('keeps the newest N', () => {
    expect(selectForPrune(series([0, 1, 2, 3, 4]), { keepLast: 2, keepDays: 0 }, now).map((f) => f.file)).toEqual(['x2', 'x3', 'x4'])
  })

  it('also keeps anything younger than keepDays', () => {
    expect(selectForPrune(series([0, 1, 2, 3, 10]), { keepLast: 1, keepDays: 5 }, now).map((f) => f.file)).toEqual(['x10'])
  })

  it('always keeps the newest, even with keepLast 0', () => {
    expect(selectForPrune(series([40, 50]), { keepLast: 0, keepDays: 1 }, now).map((f) => f.file)).toEqual(['x50'])
  })

  it('reads durations', () => {
    expect(parseDays('30d')).toBe(30)
    expect(parseDays('2w')).toBe(14)
    expect(parseDays('12h')).toBe(0.5)
    expect(() => parseDays('soon')).toThrow()
  })
})

describe('dump commands', () => {
  it('keeps the Postgres password out of argv', () => {
    const inv = pgDumpInvocation('postgres', 'postgresql://app:s%3Acr%40t@db.example.com:5433/shop?sslmode=require')
    expect(inv.env).toEqual({ PGPASSWORD: 's:cr@t' })
    expect(inv.args.join(' ')).not.toContain('s%3Acr')
    expect(inv.args.slice(0, 2)).toEqual(['--dbname', 'postgresql://app@db.example.com:5433/shop?sslmode=require'])
    expect(inv.args).not.toContain('--no-owner')
  })

  it('makes a Supabase dump portable and leaves auth + storage in', () => {
    const inv = pgDumpInvocation('supabase', 'postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres')
    expect(inv.args).toEqual(expect.arrayContaining(['--no-owner', '--no-privileges', '--exclude-schema=realtime', '--exclude-schema=supabase_functions']))
    expect(SUPABASE_EXCLUDED_SCHEMAS).not.toContain('auth')
    expect(SUPABASE_EXCLUDED_SCHEMAS).not.toContain('storage')
    expect(inferKind('postgresql://postgres:pw@db.abcd.supabase.co:5432/postgres')).toBe('supabase')
    expect(inferKind('postgres://localhost/app')).toBe('postgres')
  })

  it('dumps one MySQL database consistently, password in MYSQL_PWD', () => {
    const inv = mysqldumpInvocation('mysql://root:hunter2@127.0.0.1:3307/shop?ssl-mode=REQUIRED')
    expect(inv.env).toEqual({ MYSQL_PWD: 'hunter2' })
    expect(inv.args).toEqual(expect.arrayContaining(['--host', '127.0.0.1', '--port', '3307', '--user', 'root', '--single-transaction', '--routines', '--ssl-mode=REQUIRED']))
    expect(inv.args.at(-1)).toBe('shop')
    expect(inv.args).not.toContain('--databases')
    expect(() => mysqldumpInvocation('mysql://root@host/')).toThrow(/needs a database/)
  })

  it('restores with ON_ERROR_STOP unless told to continue', () => {
    expect(psqlInvocation('postgres://u:p@h/d').args).toContain('ON_ERROR_STOP=1')
    expect(psqlInvocation('postgres://u:p@h/d', true).args).toContain('ON_ERROR_STOP=0')
  })

  it('redacts passwords for display', () => {
    expect(redactUrl('postgres://u:secret@h/d')).toBe('postgres://u:****@h/d')
  })

  it('parses argv strictly', () => {
    const a = parseArgs(['db', '--tags=a,b', '--no-push', '--dump-arg', 'x', '--dump-arg', 'y'], { values: ['tags', 'dump-arg'], flags: ['no-push'] })
    expect(a.positional).toEqual(['db'])
    expect(a.value('tags')).toBe('a,b')
    expect(a.all('dump-arg')).toEqual(['x', 'y'])
    expect(a.flag('no-push')).toBe(true)
    expect(() => parseArgs(['--delet'], { flags: ['delete'] })).toThrow(/Unknown option/)
  })
})

describe('Postgres backups through the CLI', () => {
  it('asks for the URL, keeps it secret, dumps, verifies and lists', async () => {
    const { cli, tools, backups, settings, registry } = await setup()
    const url = 'postgresql://app:pa55word@db.internal:5432/shop'
    const added = await cli(['add', 'shop', '--kind', 'postgres', '--tags', 'prod'], [url])
    expect(added.code).toBe(0)
    expect(JSON.stringify(await settings.get('databases', []))).not.toContain('pa55word')
    expect(await registry.secretsFor('dbbackup').get('url:shop')).toBe(url)

    const listed = await cli(['list'])
    expect(listed.out).toContain('postgresql://app:****@db.internal:5432/shop')

    const ran = await cli(['run', '--tags', 'nightly'])
    expect(ran.code).toBe(0)
    expect(ran.out).toMatch(/✓ shop: shop--\d{8}T\d{6}Z--nightly\+prod\.sql\.gz/)
    expect(readFileSync(join(tools.log, 'pg_dump.password'), 'utf8')).toBe('pa55word')
    expect(readFileSync(join(tools.log, 'pg_dump.args'), 'utf8')).not.toContain('pa55word')

    const [file] = readdirSync(join(backups, 'shop'))
    const sql = gunzipSync(readFileSync(join(backups, 'shop', file!))).toString()
    expect(sql).toContain('CREATE TABLE t')
    expect(sql.trimEnd().endsWith('-- PostgreSQL database dump complete')).toBe(true)

    expect((await cli(['verify', 'shop'])).code).toBe(0)
    const json = (await cli(['backups', '--tag', 'prod', '--json'])).json as Array<{ name: string; tags: string[] }>
    expect(json).toHaveLength(1)
    expect(json[0]!.tags).toEqual(['nightly', 'prod'])
    expect((await cli(['backups', '--not', 'prod', '--json'])).json).toEqual([])
  })

  it('throws away a dump that ends without the completion line', async () => {
    const { cli, backups } = await setup({ FAKE_TRUNCATE: '1' })
    await cli(['add', 'shop', '--kind', 'postgres'], ['postgres://u:p@h/shop'])
    const ran = await cli(['run'])
    expect(ran.code).toBe(1)
    expect(ran.out).toContain('incomplete and was discarded')
    expect(readdirSync(join(backups, 'shop'))).toEqual([])
  })

  it('reports the tool’s own error when it fails', async () => {
    const { cli, backups } = await setup({ FAKE_FAIL: '1' })
    await cli(['add', 'shop', '--kind', 'postgres'], ['postgres://u:p@h/shop'])
    const ran = await cli(['run'])
    expect(ran.code).toBe(1)
    expect(ran.out).toContain('connection refused')
    expect(readdirSync(join(backups, 'shop'))).toEqual([])
  })

  it('reads the URL from an environment variable when told to, and stores nothing', async () => {
    const { cli, registry } = await setup({ SHOP_DB_URL: 'postgres://u:fromenv@h/shop' })
    expect((await cli(['add', 'shop', '--url-env', 'SHOP_DB_URL'])).code).toBe(0)
    expect(await registry.secretsFor('dbbackup').get('url:shop')).toBeNull()
    expect((await cli(['run', 'shop'])).code).toBe(0)
  })

  it('prunes per tag set and keeps the newest', async () => {
    const { cli, backups } = await setup()
    await cli(['add', 'shop', '--kind', 'postgres', '--keep-last', '2'], ['postgres://u:p@h/shop'])
    const dir = join(backups, 'shop')
    mkdirSync(dir, { recursive: true })
    for (const day of ['01', '02', '03']) writeFileSync(join(dir, `shop--202610${day}T030000Z--nightly.sql.gz`), 'x')
    writeFileSync(join(dir, 'shop--20260901T030000Z--monthly.sql.gz'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'mine')
    const pruned = await cli(['prune', '--dry-run', '--json'])
    expect((pruned.json as { removed: string[] }).removed.map((p) => p.split('/').pop())).toEqual(['shop--20261001T030000Z--nightly.sql.gz'])
    await cli(['prune'])
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'shop--20260901T030000Z--monthly.sql.gz', 'shop--20261002T030000Z--nightly.sql.gz', 'shop--20261003T030000Z--nightly.sql.gz'])
  })

  it('restores a dump through psql, after confirmation', async () => {
    const { cli, tools } = await setup({ TARGET_URL: 'postgres://u:restorepw@h/staging' })
    await cli(['add', 'shop', '--kind', 'postgres'], ['postgres://u:p@h/shop'])
    await cli(['run'])
    const refused = await cli(['restore', 'shop', '--to-env', 'TARGET_URL'], ['no'])
    expect(refused.code).toBe(1)
    expect(existsSync(join(tools.log, 'psql.stdin'))).toBe(false)
    const restored = await cli(['restore', 'shop', '--to-env', 'TARGET_URL', '--yes'])
    expect(restored.code).toBe(0)
    expect(readFileSync(join(tools.log, 'psql.stdin'), 'utf8')).toContain('-- PostgreSQL database dump complete')
    expect(readFileSync(join(tools.log, 'psql.password'), 'utf8')).toBe('restorepw')
    expect(readFileSync(join(tools.log, 'psql.args'), 'utf8')).toContain('ON_ERROR_STOP=1')
  })

  it('prints a crontab line', async () => {
    const { cli } = await setup()
    const out = (await cli(['cron', 'shop', '--at', '0 2 * * *'])).out
    expect(out).toContain('0 2 * * * mkdir -p "$HOME/.local/state" && diskpush dbbackup run shop --tags scheduled --quiet')
  })
})

describe('SQLite', () => {
  function makeDb(dir: string, file = 'app.sqlite'): string {
    const path = join(dir, file)
    execFileSync('sqlite3', [path, "PRAGMA journal_mode=WAL; CREATE TABLE notes (body text); INSERT INTO notes VALUES ('hello'), ('world');"])
    return path
  }
  const hasSqlite3 = (() => {
    try {
      execFileSync('sqlite3', ['-version'])
      return true
    } catch {
      return false
    }
  })()

  it.skipIf(!hasSqlite3)('backs up from the file browser, verifies, and restores', async () => {
    const { registry, host, backups, cli } = await setup()
    const dir = temp('src')
    makeDb(dir)
    writeFileSync(join(dir, 'fake.db'), 'not a database')

    const result = await runAction(registry, 'dbbackup', 'backup-sqlite', { ...host(), dir, names: ['app.sqlite', 'fake.db'] })
    expect(result.ok).toBe(false) // fake.db is refused
    expect(result.message).toContain('fake.db is not a SQLite database')
    const [file] = readdirSync(join(backups, 'app'))
    expect(file).toMatch(/^app--\d{8}T\d{6}Z--manual\.sqlite\.gz$/)

    const verified = await runAction(registry, 'dbbackup', 'verify', { ...host(), dir: join(backups, 'app'), names: [file!] })
    expect(verified).toEqual({ ok: true, message: '1 backup OK.' })

    const target = join(temp('restore'), 'restored.sqlite')
    expect((await cli(['restore', 'app', '--to', target, '--yes'])).code).toBe(0)
    expect(execFileSync('sqlite3', [target, 'SELECT group_concat(body) FROM notes']).toString().trim()).toBe('hello,world')
    expect((await cli(['restore', 'app', '--to', target, '--yes'])).err).toContain('Pass --force')
  })

  it.skipIf(!hasSqlite3)('uses the sqlite3 binary where node:sqlite has no backup (Electron 33)', async () => {
    const dir = temp('cli')
    const source = makeDb(dir)
    const final = join(dir, 'out', 'app--20261017T000000Z.sqlite.gz')
    await sqliteToFile({ source, final, sqlite3: 'sqlite3', env: process.env, signal: new AbortController().signal, useNodeSqlite: false })
    const copy = join(dir, 'copy.sqlite')
    writeFileSync(copy, gunzipSync(readFileSync(final)))
    expect(execFileSync('sqlite3', [copy, 'SELECT count(*) FROM notes']).toString().trim()).toBe('2')
  })

  it('backs up a saved SQLite database from the "every database" task', async () => {
    const { registry, host, cli, backups } = await setup()
    if (!hasSqlite3) return
    const path = makeDb(temp('task'))
    await cli(['add', 'notes', '--path', path])
    const result = await runTask(registry, 'dbbackup', 'run-all', host())
    expect(result).toEqual({ ok: true, message: 'Backed up 1 database.' })
    expect(readdirSync(join(backups, 'notes'))).toHaveLength(1)
  })
})

describe('push', () => {
  const hasRsync = (() => {
    try {
      execFileSync('rsync', ['--version'])
      return true
    } catch {
      return false
    }
  })()

  it('builds a delete-mirroring push that can only delete its own files', () => {
    expect(rsyncPushArgs('/b/shop/', 'nas:/srv/db/', 'shop')).toEqual([
      '--archive', '--partial', '--mkpath', '--delete', '--filter=P! shop--*', '--exclude=.*', '/b/shop/', 'nas:/srv/db/shop/',
    ])
  })

  it.skipIf(!hasRsync)('mirrors pruning to the destination and never touches other files there', async () => {
    const { cli, settings } = await setup()
    const remote = temp('remote')
    mkdirSync(join(remote, 'shop'))
    writeFileSync(join(remote, 'shop', 'important.txt'), 'not ours')
    writeFileSync(join(remote, 'shop', 'shop--20200101T000000Z.sql.gz'), 'old, pruned locally')
    await settings.set('push', remote)
    await cli(['add', 'shop', '--kind', 'postgres'], ['postgres://u:p@h/shop'])
    const ran = await cli(['run'])
    expect(ran.code).toBe(0)
    expect(ran.out).toContain(`pushed to ${remote}`)
    const files = readdirSync(join(remote, 'shop')).sort()
    expect(files).toContain('important.txt')
    expect(files).not.toContain('shop--20200101T000000Z.sql.gz')
    expect(files.filter((f) => f.endsWith('.sql.gz'))).toHaveLength(1)
  })
})
