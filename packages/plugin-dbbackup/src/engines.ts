/**
 * How each kind of database is dumped and restored.
 *
 * Everything here is pure: it turns a connection into the argv and environment
 * for pg_dump / psql / mysqldump / mysql, so the exact commands are testable
 * without a database. Passwords never go in argv (where `ps` and shell history
 * would show them): Postgres gets PGPASSWORD, MySQL gets MYSQL_PWD.
 */
import { accessSync, constants, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Kind } from './naming.js'

export type Invocation = {
  /** Argv after the program name. */
  args: string[]
  /** Added to the child's environment. */
  env: Record<string, string>
}

/**
 * Supabase schemas the platform creates and owns, which hold no data of yours
 * and which a restore into another project would collide with. `auth`,
 * `storage` and `supabase_migrations` are deliberately NOT here: your users,
 * your file metadata and your migration history are in them.
 */
export const SUPABASE_EXCLUDED_SCHEMAS = [
  '_analytics',
  '_realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'net',
  'pgbouncer',
  'pgsodium',
  'pgsodium_masks',
  'realtime',
  'supabase_functions',
  'vault',
] as const

/** The last line each dump tool writes. A dump without it was cut short. */
export const TRAILERS: Record<Exclude<Kind, 'sqlite'>, string> = {
  postgres: '-- PostgreSQL database dump complete',
  supabase: '-- PostgreSQL database dump complete',
  mysql: '-- Dump completed',
}

export type PostgresTarget = {
  /** The URL without its password, for --dbname. */
  url: string
  password: string | null
  database: string
}

export function parsePostgresUrl(input: string): PostgresTarget {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('That is not a connection URL. Expected postgres://user:password@host:5432/database')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Expected a postgres:// URL, got ${url.protocol}//`)
  }
  if (!url.hostname) throw new Error('The connection URL has no host.')
  const password = url.password ? decodeURIComponent(url.password) : null
  url.password = ''
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || decodeURIComponent(url.username) || 'postgres'
  return { url: url.toString(), password, database }
}

export type MysqlTarget = {
  host: string
  port: string | null
  user: string | null
  password: string | null
  database: string
  /** `?ssl-mode=REQUIRED` becomes `--ssl-mode=REQUIRED`. */
  options: string[]
}

export function parseMysqlUrl(input: string): MysqlTarget {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('That is not a connection URL. Expected mysql://user:password@host:3306/database')
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
    throw new Error(`Expected a mysql:// URL, got ${url.protocol}//`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) throw new Error('A MySQL backup needs a database: mysql://user:password@host:3306/DATABASE')
  const options: string[] = []
  for (const [key, value] of url.searchParams) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`"${key}" is not a mysqldump option.`)
    options.push(value === '' || value === 'true' ? `--${key}` : `--${key}=${value}`)
  }
  return {
    host: url.hostname || 'localhost',
    port: url.port || null,
    user: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    database,
    options,
  }
}

/** A URL safe to print: the password replaced. */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input)
    if (url.password) url.password = '****'
    return url.toString()
  } catch {
    return input
  }
}

export function pgDumpInvocation(kind: 'postgres' | 'supabase', connection: string, extraArgs: readonly string[] = []): Invocation {
  const target = parsePostgresUrl(connection)
  const args = ['--dbname', target.url, '--format=plain', '--no-password']
  if (kind === 'supabase') {
    // Supabase roles (supabase_admin, authenticator, …) exist only on Supabase;
    // owning objects by them makes a dump unrestorable anywhere else.
    args.push('--no-owner', '--no-privileges')
    for (const schema of SUPABASE_EXCLUDED_SCHEMAS) args.push(`--exclude-schema=${schema}`)
  }
  args.push(...extraArgs)
  return { args, env: target.password ? { PGPASSWORD: target.password } : {} }
}

export function psqlInvocation(connection: string, continueOnError = false): Invocation {
  const target = parsePostgresUrl(connection)
  const args = ['--dbname', target.url, '--no-password', '--no-psqlrc', '--quiet', '--set', `ON_ERROR_STOP=${continueOnError ? 0 : 1}`]
  return { args, env: target.password ? { PGPASSWORD: target.password } : {} }
}

function mysqlConnectionArgs(target: MysqlTarget): string[] {
  const args = ['--host', target.host]
  if (target.port) args.push('--port', target.port)
  if (target.user) args.push('--user', target.user)
  return args
}

export function mysqldumpInvocation(connection: string, extraArgs: readonly string[] = []): Invocation {
  const target = parseMysqlUrl(connection)
  const args = [
    ...mysqlConnectionArgs(target),
    // A consistent snapshot of InnoDB without locking the tables for the length of the dump.
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--default-character-set=utf8mb4',
    ...target.options,
    ...extraArgs,
    // Last, and alone: no --databases, so the dump restores into a database of any name.
    target.database,
  ]
  return { args, env: target.password ? { MYSQL_PWD: target.password } : {} }
}

export function mysqlRestoreInvocation(connection: string): Invocation {
  const target = parseMysqlUrl(connection)
  const args = [...mysqlConnectionArgs(target), '--default-character-set=utf8mb4', ...target.options, target.database]
  return { args, env: target.password ? { MYSQL_PWD: target.password } : {} }
}

/** A path inside a sqlite3 dot-command, single-quoted. */
export function sqliteQuote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

export type Tool = 'pg_dump' | 'psql' | 'mysqldump' | 'mysql' | 'sqlite3' | 'rsync'

const CANDIDATES: Record<Tool, string[]> = {
  pg_dump: ['pg_dump'],
  psql: ['psql'],
  // MariaDB 11 ships only the mariadb-* names.
  mysqldump: ['mysqldump', 'mariadb-dump'],
  mysql: ['mysql', 'mariadb'],
  sqlite3: ['sqlite3'],
  rsync: ['rsync'],
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Debian/Ubuntu install every Postgres major side by side under
 * /usr/lib/postgresql/<major>/bin and PATH holds a wrapper that picks one by
 * cluster, which is often older than the server being dumped. pg_dump refuses
 * a server newer than itself, so the newest one present is the one to use.
 */
function versionedPostgresDirs(): string[] {
  const roots = ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt']
  const out: Array<{ dir: string; major: number }> = []
  for (const root of roots) {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const m = /^(?:postgresql@)?(\d+)$/.exec(name)
      if (m) out.push({ dir: join(root, name, 'bin'), major: Number(m[1]) })
    }
  }
  return out.sort((a, b) => b.major - a.major).map((entry) => entry.dir)
}

/** The path of a tool, or null. `override` (a setting) wins; then the newest Postgres; then PATH. */
export function findTool(tool: Tool, env: Readonly<Record<string, string | undefined>>, override?: string | null): string | null {
  if (override) return isExecutable(override) ? override : null
  const extension = process.platform === 'win32' ? '.exe' : ''
  const dirs = [
    ...(tool === 'pg_dump' || tool === 'psql' ? versionedPostgresDirs() : []),
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
  ]
  for (const name of CANDIDATES[tool]) {
    for (const dir of dirs) {
      const path = join(dir, name + extension)
      if (isExecutable(path)) return path
    }
  }
  return null
}

export const INSTALL_HINT: Record<Tool, string> = {
  pg_dump: 'Install the Postgres client tools at least as new as the server (apt install postgresql-client-17, brew install libpq).',
  psql: 'Install the Postgres client tools (apt install postgresql-client, brew install libpq).',
  mysqldump: 'Install the MySQL or MariaDB client (apt install default-mysql-client, brew install mysql-client).',
  mysql: 'Install the MySQL or MariaDB client (apt install default-mysql-client, brew install mysql-client).',
  sqlite3: 'Install sqlite3 (apt install sqlite3, brew install sqlite), or run DiskPush on Node 22.16 or newer.',
  rsync: 'Needed only to push backups (apt install rsync, brew install rsync).',
}
