/**
 * Finding every database on the user's servers.
 *
 * One read-only shell script goes to each server in a single ssh call and
 * prints what it finds as tab-separated records:
 *
 *   - Postgres, Supabase and MySQL/MariaDB containers (`docker ps`), and the
 *     databases inside each, asked through `docker exec` the way a backup
 *     will later dump them, so a database that is listed is one that dumps;
 *   - native Postgres clusters (as the postgres OS user) and MySQL (as root);
 *   - SQLite files under the usual app roots, by their header, not their name;
 *   - database URLs in app env files, password masked on the server, so a
 *     database can be named after the app that uses it.
 *
 * Nothing the script runs writes anything, and nothing that is missing (no
 * docker, no sudo, no sqlite3) stops it: each becomes a warning.
 */
import { PassThrough } from 'node:stream'
import type { BaseContext, ServerRef } from '@diskpush/plugin-api'
import { findTool } from './engines.js'
import { isValidName, type Kind } from './naming.js'
import { loadDatabases, saveDatabases, type DatabaseConfig } from './ops.js'
import { LOCAL_SERVER, commandOn, isRunAs, type RunAs } from './remote.js'
import { run } from './runner.js'

/**
 * The probe. Plain POSIX sh, sent as `sh -c` (never on stdin, which a
 * `docker exec` inside a `while read` loop would swallow), with every inner
 * command's stdin closed for the same reason.
 *
 * Written without `${…}` so it can sit in a raw template string unchanged.
 */
export const PROBE_SCRIPT = String.raw`
set +e
LC_ALL=C; export LC_ALL
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/snap/bin"
TAB=$(printf '\t')
uid=$(id -u)
SUDO=""
if [ "$uid" = 0 ]; then ACCESS=root; elif sudo -n true </dev/null >/dev/null 2>&1; then SUDO="sudo -n"; ACCESS=sudo; else ACCESS=user; fi
MID=$(cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null)
printf 'host\t%s\t%s\t%s\t%s\n' "$(hostname -f 2>/dev/null || hostname)" "$(id -un)" "$ACCESS" "$MID"
for t in docker psql pg_dump mysql mysqldump mariadb-dump sqlite3; do
  p=$(command -v "$t" 2>/dev/null)
  printf 'tool\t%s\t%s\n' "$t" "$p"
done

D=""
if command -v docker >/dev/null 2>&1; then
  if docker ps -q </dev/null >/dev/null 2>&1; then D="docker"; DRUN=""
  elif [ -n "$SUDO" ] && sudo -n docker ps -q </dev/null >/dev/null 2>&1; then D="sudo -n docker"; DRUN="sudo -n"
  else printf 'warn\tdocker is here but this login cannot use it (not root, not in the docker group, no passwordless sudo)\n'
  fi
fi

pgq() {
  c=$1; h=$2; u=$3; sql=$4
  if [ -n "$h" ]; then $D exec "$c" psql -h "$h" -U "$u" -d template1 -X -A -t -F "$TAB" -c "$sql" </dev/null 2>/dev/null
  else $D exec "$c" psql -U "$u" -d template1 -X -A -t -F "$TAB" -c "$sql" </dev/null 2>/dev/null; fi
}
pgdbq() {
  c=$1; h=$2; u=$3; db=$4; sql=$5
  if [ -n "$h" ]; then $D exec "$c" psql -h "$h" -U "$u" -d "$db" -X -A -t -c "$sql" </dev/null 2>/dev/null
  else $D exec "$c" psql -U "$u" -d "$db" -X -A -t -c "$sql" </dev/null 2>/dev/null; fi
}
LISTDB="select datname, pg_database_size(datname) from pg_database where not datistemplate and datallowconn order by 1"
COUNT="select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')"

if [ -n "$D" ]; then
  $D ps --format '{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}' </dev/null 2>/dev/null | while IFS="$TAB" read -r name image project ports; do
    case "$image" in
      *postgres-meta*|*postgrest*|*pgbouncer*|*pgadmin*|*supavisor*|*pooler*|*pgcat*|*exporter*|*backup*) continue ;;
    esac
    eng=""
    case "$image" in
      *supabase/postgres*) eng=supabase ;;
      *postgres*|*postgis*|*timescale*|*pgvector*|*paradedb*) eng=postgres ;;
      *mariadb*|*mysql*) eng=mysql ;;
    esac
    [ -n "$eng" ] || continue
    case "$project" in *-supabase|*_supabase|supabase*) [ "$eng" = postgres ] && eng=supabase ;; esac
    [ -n "$project" ] || project=-
    [ -n "$ports" ] || ports=-
    if [ "$eng" = mysql ]; then
      out=$($D exec "$name" sh -c 'P=$MYSQL_ROOT_PASSWORD; [ -n "$P" ] || P=$MARIADB_ROOT_PASSWORD; export MYSQL_PWD="$P"; C=$(command -v mariadb || command -v mysql) && "$C" -uroot -N -B -e "select s.schema_name, coalesce(sum(t.data_length + t.index_length), 0) from information_schema.schemata s left join information_schema.tables t on t.table_schema = s.schema_name where s.schema_name not in (\"information_schema\", \"performance_schema\", \"mysql\", \"sys\") group by s.schema_name"' </dev/null 2>/dev/null)
      if [ -n "$out" ]; then
        printf '%s\n' "$out" | while IFS="$TAB" read -r db bytes; do
          printf 'db\tmysql\tdocker\t%s\t%s\t%s\t%s\t%s\t-\troot\t-\t%s\t%s\t-\n' "$name" "$image" "$project" "$ports" "$DRUN" "$db" "$bytes"
        done
      else
        printf 'warn\t%s (%s): could not list its databases as root with the container'"'"'s own password\n' "$name" "$image"
      fi
      continue
    fi
    envuser=$($D exec "$name" printenv POSTGRES_USER </dev/null 2>/dev/null)
    out=""; h=""; u=""
    for cand in "|$envuser" "|postgres" "|supabase_admin" "127.0.0.1|postgres" "127.0.0.1|supabase_admin" "127.0.0.1|$envuser"; do
      h=$(printf '%s' "$cand" | cut -d'|' -f1); u=$(printf '%s' "$cand" | cut -d'|' -f2)
      [ -n "$u" ] || continue
      out=$(pgq "$name" "$h" "$u" "$LISTDB")
      [ -n "$out" ] && break
    done
    if [ -z "$out" ]; then
      printf 'warn\t%s (%s): psql inside it would not let any of postgres, supabase_admin or POSTGRES_USER in\n' "$name" "$image"
      continue
    fi
    printf '%s\n' "$out" | while IFS="$TAB" read -r db bytes; do
      [ -n "$db" ] || continue
      tables=-
      if [ "$db" = postgres ] && [ "$eng" = postgres ]; then tables=$(pgdbq "$name" "$h" "$u" "$db" "$COUNT"); fi
      hh=$h; [ -n "$hh" ] || hh=-
      printf 'db\t%s\tdocker\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t-\t%s\t%s\t%s\n' "$eng" "$name" "$image" "$project" "$ports" "$DRUN" "$hh" "$u" "$db" "$bytes" "$tables"
    done
  done
fi

if command -v psql >/dev/null 2>&1; then
  PGAS=""
  if [ "$uid" = 0 ] && command -v runuser >/dev/null 2>&1; then PGAS="runuser -u postgres --"; fi
  if sudo -n -u postgres true </dev/null >/dev/null 2>&1; then PGAS="sudo -n -u postgres"; fi
  if [ -n "$PGAS" ]; then
    pports=""
    if command -v pg_lsclusters >/dev/null 2>&1; then pports=$(pg_lsclusters -h 2>/dev/null </dev/null | awk '$4 == "online" { print $3 }'); fi
    [ -n "$pports" ] || pports=5432
    for port in $pports; do
      out=$($PGAS psql -p "$port" -d template1 -X -A -t -F "$TAB" -c "$LISTDB" </dev/null 2>/dev/null)
      [ -n "$out" ] || continue
      printf '%s\n' "$out" | while IFS="$TAB" read -r db bytes; do
        [ -n "$db" ] || continue
        tables=-
        if [ "$db" = postgres ]; then tables=$($PGAS psql -p "$port" -d postgres -X -A -t -c "$COUNT" </dev/null 2>/dev/null); fi
        printf 'db\tpostgres\tnative\t-\t-\t-\t-\t%s\t-\tpostgres\t%s\t%s\t%s\t%s\n' "$PGAS" "$port" "$db" "$bytes" "$tables"
      done
    done
  elif [ -S /var/run/postgresql/.s.PGSQL.5432 ]; then
    printf 'warn\ta native Postgres is running, but this login cannot become the postgres user (no root, no passwordless sudo)\n'
  fi
fi

MYC=$(command -v mariadb 2>/dev/null || command -v mysql 2>/dev/null)
if [ -n "$MYC" ] && { [ -S /var/run/mysqld/mysqld.sock ] || [ -S /run/mysqld/mysqld.sock ]; }; then
  MYAS=""
  [ "$uid" = 0 ] || MYAS="$SUDO"
  if [ "$uid" = 0 ] || [ -n "$SUDO" ]; then
    out=$($MYAS "$MYC" -uroot -N -B -e "select s.schema_name, coalesce(sum(t.data_length + t.index_length), 0) from information_schema.schemata s left join information_schema.tables t on t.table_schema = s.schema_name where s.schema_name not in ('information_schema', 'performance_schema', 'mysql', 'sys') group by s.schema_name" </dev/null 2>/dev/null)
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | while IFS="$TAB" read -r db bytes; do
        printf 'db\tmysql\tnative\t-\t-\t-\t-\t%s\t-\troot\t-\t%s\t%s\t-\n' "$MYAS" "$db" "$bytes"
      done
    else
      printf 'warn\ta native MySQL/MariaDB is running, but root could not sign in through its socket\n'
    fi
  else
    printf 'warn\ta native MySQL/MariaDB is running, but this login is not root and has no passwordless sudo\n'
  fi
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'warn\tsqlite3 is not installed here, so SQLite files found here cannot be backed up until it is\n'
fi
roots=""
for r in $ROOTS; do [ -d "$r" ] && roots="$roots $r"; done
if [ -n "$roots" ]; then
  $SUDO find $roots -xdev -maxdepth 7 \( -name node_modules -o -name .git -o -name .cache -o -name .local -o -name .config -o -name .npm -o -name .bun -o -name .cargo -o -name .rustup -o -name .nvm -o -name .mozilla -o -name snap -o -name .vscode-server -o -name .cursor-server -o -name .pm2 -o -name .Trash -o -name .opencode -o -name .claude -o -name .codex -o -name .ollama -o -name .docker -o -name .android -o -name .gradle -o -name .m2 -o -name .pki -o -name .omp -o -name '*-worktrees' -o -name worktrees -o -path '/home/*/src' -o -path '/root/src' -o -path '/home/*/go' -o -path '/root/go' -o -path '/home/*/scratch' -o -path '/home/*/Downloads' -o -name backups -o -name backup -o -name tmp -o \( -type d -name '.?*' \) \) -prune -o -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db3' \) -print 2>/dev/null </dev/null | head -n "$MAXFILES" | while IFS= read -r f; do
    case "$f" in
      */opencode.db|*/opencode-*.db) printf 'skip\t%s\tagent scratch (opencode)\n' "$f"; continue ;;
    esac
    b=$(basename "$f")
    case "$b" in
      .*) printf 'skip\t%s\ta hidden file (test or scratch)\n' "$f"; continue ;;
      *.bak*|*-bak-*|*_bak_*|*backup*|*.orig.*|*-replica.*|*_replica.*) printf 'skip\t%s\ta copy or replica of another database\n' "$f"; continue ;;
    esac
    h=$($SUDO head -c 15 "$f" </dev/null 2>/dev/null)
    [ "$h" = "SQLite format 3" ] || continue
    bytes=$($SUDO wc -c "$f" </dev/null 2>/dev/null | awk '{ print $1 }')
    if [ -n "$bytes" ] && [ "$bytes" -gt "$MAXBYTES" ]; then printf 'skip\t%s\tlarger than the SQLite size cap (%s bytes)\n' "$f" "$bytes"; continue; fi
    if [ -r "$f" ]; then as=""; else as="$SUDO"; fi
    printf 'sqlite\t%s\t%s\t%s\n' "$f" "$bytes" "$as"
  done
fi

for f in /root/www/*/app.env /root/www/*/.env /home/*/www/*/app.env /home/*/www/*/.env /srv/*/.env /opt/*/.env /var/www/*/.env /srv/*/app.env /opt/*/app.env; do
  [ -f "$f" ] || continue
  grep -E '^(export )?[A-Z0-9_]*(DATABASE|POSTGRES|PG|MYSQL|DB)[A-Z0-9_]*URL=' "$f" </dev/null 2>/dev/null \
    | sed -E 's/^export //; s#(://[^:/@]*):[^@]*@#\1:****@#' \
    | while IFS= read -r line; do printf 'env\t%s\t%s\n' "$f" "$line"; done
done
exit 0
`

/** Where the probe looks for SQLite files. */
export const SQLITE_ROOTS = ['/srv', '/opt', '/var/www', '/root', '/home']

/** Settings the probe reads, prepended as plain assignments. */
export function probeScript(options: { maxSqliteBytes: number; maxFiles: number; roots?: readonly string[] }): string {
  const roots = (options.roots ?? SQLITE_ROOTS).filter((root) => /^\/[A-Za-z0-9_./-]*$/.test(root)).join(' ')
  return [
    `MAXBYTES=${Math.max(0, Math.floor(options.maxSqliteBytes))}`,
    `MAXFILES=${Math.max(1, Math.floor(options.maxFiles))}`,
    `ROOTS='${roots}'`,
    PROBE_SCRIPT,
  ].join('\n')
}

export type Found = {
  server: string
  kind: Kind
  via: 'docker' | 'native' | 'file'
  container?: string
  image?: string
  project?: string
  /** Host ports the container publishes. */
  ports?: number[]
  database?: string
  path?: string
  dbUser?: string
  dbHost?: string
  port?: number
  runAs: RunAs
  bytes: number | null
  /** User tables in a `postgres` database: none means the cluster's empty default, not data. */
  tables?: number
  /** Apps whose env files point at this database. */
  owners: string[]
}

export type EnvUrl = { file: string; variable: string; url: string; app: string }

export type ServerReport = {
  server: string
  ok: boolean
  error?: string
  hostname?: string
  user?: string
  access?: 'root' | 'sudo' | 'user'
  tools: Record<string, string | null>
  found: Found[]
  envUrls: EnvUrl[]
  warnings: string[]
  skipped: { path: string; reason: string }[]
  /** /etc/machine-id: two aliases that reach the same machine report the same one. */
  machineId?: string
  /** Another alias reached this same machine with at least as much access; its databases are listed there. */
  duplicateOf?: string
}

const dash = (value: string | undefined) => (value === undefined || value === '-' || value === '' ? undefined : value)

function number(value: string | undefined): number | null {
  if (value === undefined || value === '-' || value.trim() === '') return null
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : null
}

/** `0.0.0.0:5500->5432/tcp, :::5500->5432/tcp` → `[5500]`. */
export function publishedPorts(ports: string | undefined): number[] {
  const out = new Set<number>()
  for (const match of (ports ?? '').matchAll(/:(\d+)->/g)) out.add(Number(match[1]))
  return [...out]
}

/** The app an env file belongs to: `/root/www/nichedb.dev/app.env` → `nichedb.dev`. */
export function appOf(file: string): string {
  const parts = file.split('/').filter(Boolean)
  return parts.at(-2) ?? file
}

/** Turns the probe's output into a report. Lines it does not know are ignored, so an older plugin reads a newer probe. */
export function parseProbe(server: string, output: string): ServerReport {
  const report: ServerReport = { server, ok: true, tools: {}, found: [], envUrls: [], warnings: [], skipped: [] }
  for (const line of output.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t')
    switch (f[0]) {
      case 'host': {
        report.hostname = f[1]
        report.user = f[2]
        if (f[3] === 'root' || f[3] === 'sudo' || f[3] === 'user') report.access = f[3]
        if (f[4] && /^[0-9a-f]{16,64}$/i.test(f[4].trim())) report.machineId = f[4].trim().toLowerCase()
        break
      }
      case 'tool':
        if (f[1]) report.tools[f[1]] = f[2] || null
        break
      case 'warn':
        if (f[1]) report.warnings.push(f.slice(1).join(' '))
        break
      case 'skip':
        if (f[1]) report.skipped.push({ path: f[1], reason: f[2] ?? '' })
        break
      case 'db': {
        // db kind via container image project ports runAs dbHost dbUser port database bytes tables
        const [, kind, via, container, image, project, ports, runAs = '', dbHost, dbUser, port, database, bytes, tables] = f
        if ((kind !== 'postgres' && kind !== 'supabase' && kind !== 'mysql') || (via !== 'docker' && via !== 'native')) break
        if (!database || !isRunAs(runAs)) break
        const found: Found = { server, kind, via, runAs, database, bytes: number(bytes), owners: [] }
        if (dash(container)) found.container = container!
        if (dash(image)) found.image = image!
        if (dash(project)) found.project = project!
        const published = publishedPorts(dash(ports))
        if (published.length) found.ports = published
        if (dash(dbHost)) found.dbHost = dbHost!
        if (dash(dbUser)) found.dbUser = dbUser!
        const p = number(port)
        if (p !== null) found.port = p
        const t = number(tables)
        if (t !== null) found.tables = t
        report.found.push(found)
        break
      }
      case 'sqlite': {
        const [, path, bytes, runAs = ''] = f
        if (!path || !isRunAs(runAs)) break
        report.found.push({ server, kind: 'sqlite', via: 'file', path, runAs, bytes: number(bytes), owners: [] })
        break
      }
      case 'env': {
        const [, file, assignment = ''] = f
        const eq = assignment.indexOf('=')
        if (!file || eq < 1) break
        const url = assignment.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
        if (!/^(postgres(ql)?|mysql|mariadb):\/\//i.test(url)) break
        report.envUrls.push({ file, variable: assignment.slice(0, eq), url, app: appOf(file) })
        break
      }
      default:
        break
    }
  }
  report.found = report.found.filter(isData)
  attachOwners(report)
  return report
}

/** Platform databases that hold nothing of the user's. */
function isData(found: Found): boolean {
  if (found.kind === 'supabase' && found.database === '_supabase') return false
  // The empty default database every Postgres cluster has. With tables, it is someone's data.
  if (found.kind === 'postgres' && found.database === 'postgres' && (found.tables ?? 0) === 0) return false
  return true
}

/**
 * Which app uses each database, from the env file URLs: a URL names a
 * database and a port, and the port is a container's published one or a
 * native cluster's. A name alone decides only when exactly one database on
 * the server has it.
 */
function attachOwners(report: ServerReport): void {
  for (const env of report.envUrls) {
    let url: URL
    try {
      url = new URL(env.url)
    } catch {
      continue
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres'
    const port = url.port ? Number(url.port) : null
    const named = report.found.filter((found) => found.database === database)
    const byPort = named.filter(
      (found) =>
        port !== null &&
        (found.ports?.includes(port) || (found.via === 'native' && (found.port ?? 5432) === port)),
    )
    const byHost = named.filter((found) => found.container && found.container === url.hostname)
    const match = byPort.length ? byPort : byHost.length ? byHost : named.length === 1 ? named : []
    for (const found of match) if (!found.owners.includes(env.app)) found.owners.push(env.app)
  }
  for (const found of report.found) found.owners.sort()
}

/** Lowercase letters, digits, `_` and single dashes: what a saved name may hold. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.(sqlite3?|db3?)$/, '')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A saved name for a found database, unique among `taken`: the server, then
 * what a person would call the database.
 *
 *   dev2 + supabase project nichedb-supabase      → dev2-nichedb-supabase
 *   dev2 + postgres database crawlproof           → dev2-crawlproof
 *   bbs  + /root/www/agentbbs/data/bbs.sqlite     → bbs-agentbbs-bbs
 */
export function suggestName(found: Found, taken: ReadonlySet<string>): string {
  let base: string
  if (found.kind === 'sqlite') {
    const parts = (found.path ?? '').split('/').filter(Boolean)
    const file = parts.at(-1) ?? 'sqlite'
    const app = parts.find((_, i) => i > 0 && (parts[i - 1] === 'www' || parts[i - 1] === 'srv' || parts[i - 1] === 'opt')) ?? parts.at(-2) ?? ''
    base = app && slug(app) !== slug(file) ? `${app}-${file}` : file
  } else if (found.kind === 'supabase' && found.database !== 'postgres') {
    // One cluster holding a database per app: the database is the app.
    base = found.database!
  } else if (found.kind === 'supabase' && found.project) {
    const stack = found.project.replace(/[-_]?supabase$/, '')
    base = stack ? `${stack}-supabase` : 'supabase'
  } else if (found.database === 'postgres' && found.container) {
    base = found.container
  } else {
    base = found.owners.length === 1 && slug(found.owners[0]!).startsWith(slug(found.database ?? '')) ? found.database! : found.database ?? 'db'
  }
  const stem = slug(`${found.server}-${base}`).slice(0, 60).replace(/-+$/, '') || 'db'
  let name = stem
  for (let n = 2; taken.has(name) || !isValidName(name); n++) name = `${stem}-${n}`
  return name
}

/** Whether a saved database is this found one. */
export function sameDatabase(saved: DatabaseConfig, found: Found): boolean {
  if (saved.server !== found.server || saved.kind !== found.kind) return false
  if (found.kind === 'sqlite') return saved.path === found.path
  return (
    saved.via === found.via &&
    saved.database === found.database &&
    (found.via === 'docker' ? saved.container === found.container : (saved.port ?? 5432) === (found.port ?? 5432))
  )
}

/** The saved form of a found database. */
export function toConfig(found: Found, name: string, defaults: Pick<DatabaseConfig, 'tags' | 'push' | 'keepLast' | 'keepDays'>): DatabaseConfig {
  const db: DatabaseConfig = { name, kind: found.kind, server: found.server, tags: [...defaults.tags] }
  if (found.kind === 'sqlite') db.path = found.path!
  else {
    db.via = found.via as 'docker' | 'native'
    db.database = found.database!
    if (found.container) db.container = found.container
    if (found.dbUser) db.dbUser = found.dbUser
    if (found.dbHost) db.dbHost = found.dbHost
    if (found.port !== undefined) db.port = found.port
  }
  if (found.runAs) db.runAs = found.runAs
  if (defaults.push) db.push = defaults.push
  if (defaults.keepLast !== undefined) db.keepLast = defaults.keepLast
  if (defaults.keepDays !== undefined) db.keepDays = defaults.keepDays
  return db
}

export type DiscoverOptions = {
  /** Server names; empty means every server the host knows. `local` is this machine. */
  servers?: readonly string[]
  /** Probe this machine too. */
  local?: boolean
  acceptNew?: boolean
  /** At most this many servers probed at once. */
  concurrency?: number
  timeoutSeconds?: number
  maxSqliteBytes?: number
  maxFiles?: number
  /** Where to look for SQLite files; default SQLITE_ROOTS. */
  sqliteRoots?: readonly string[]
}

const PROBE_DEFAULTS = { concurrency: 4, timeoutSeconds: 180, maxSqliteBytes: 4 * 1024 ** 3, maxFiles: 2000 }

/** Runs the probe on one server (null: this machine) and parses it. Never throws: a failure is the report's `error`. */
export async function probeServer(
  ctx: BaseContext,
  name: string,
  server: ServerRef | null,
  options: DiscoverOptions = {},
): Promise<ServerReport> {
  const settings = { ...PROBE_DEFAULTS, ...dropUndefined(options) }
  const empty: ServerReport = { server: name, ok: false, tools: {}, found: [], envUrls: [], warnings: [], skipped: [] }
  if (server?.passwordAuth) return { ...empty, error: 'signs in with a password; discovery and backups need a key or an agent' }
  const ssh = server ? findTool('ssh', ctx.env) : '/bin/sh'
  if (!ssh) return { ...empty, error: 'ssh was not found on PATH' }
  const { program, args } = commandOn(server, `sh -c ${shellWord(probeScript({ ...settings, ...(options.sqliteRoots ? { roots: options.sqliteRoots } : {}) }))}`, ssh, {
    knownHostsFiles: ctx.servers?.knownHostsFiles ?? [],
    sshConfigFile: ctx.servers?.sshConfigFile ?? null,
    acceptNew: options.acceptNew ?? false,
  })
  const out = new PassThrough()
  let text = ''
  out.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(settings.timeoutSeconds * 1000)])
  try {
    await run({ program, args, env: ctx.env, signal, stdout: out })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = !ctx.signal.aborted && signal.aborted
    if (timedOut) return { ...empty, error: `no answer within ${settings.timeoutSeconds}s` }
    // ssh says why on stderr; a bare "exited 1" means the login gave no shell (a BBS, a git-only or forced-command account).
    const detail = message.includes('\n') ? message.slice(message.indexOf('\n') + 1).trim() : ''
    return { ...empty, error: detail || `${message}: the login did not run a shell (a forced command or a non-shell service on that port?)` }
  }
  return parseProbe(name, text)
}

function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Hosts that answer ssh with a git service, never a shell. */
const NO_SHELL = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht|aur\.archlinux\.org|dev\.azure\.com|visualstudio\.com|huggingface\.co)$/i

export type SkippedServer = { name: string; reason: string }

/**
 * Which of the user's servers to look on when none were named: not git
 * forges (a ~/.ssh/config full of deploy-key aliases is common), and one
 * alias per user@host:port.
 */
export function pickServers(known: readonly ServerRef[]): { chosen: ServerRef[]; skipped: SkippedServer[] } {
  const chosen: ServerRef[] = []
  const skipped: SkippedServer[] = []
  const seen = new Map<string, string>()
  for (const server of known) {
    if (server.username === 'git' || NO_SHELL.test(server.host)) {
      skipped.push({ name: server.name, reason: 'a git host, no shell' })
      continue
    }
    const key = `${server.username}@${server.host.toLowerCase()}:${server.port}`
    const first = seen.get(key)
    if (first) {
      skipped.push({ name: server.name, reason: `same login as ${first}` })
      continue
    }
    seen.set(key, server.name)
    chosen.push(server)
  }
  return { chosen, skipped }
}

const ACCESS_RANK = { root: 3, sudo: 2, user: 1 } as const

/**
 * Two aliases (`dev2` and `dev2-root`, or a name and an IP) can reach one
 * machine. Its databases are listed once, under the alias with the most
 * access; the others are marked `duplicateOf` and emptied.
 */
export function mergeSameMachine(reports: ServerReport[]): ServerReport[] {
  const best = new Map<string, ServerReport>()
  for (const report of reports) {
    if (!report.ok || !report.machineId) continue
    const current = best.get(report.machineId)
    const rank = (r: ServerReport) => ACCESS_RANK[r.access ?? 'user']
    if (!current || rank(report) > rank(current)) best.set(report.machineId, report)
  }
  return reports.map((report) => {
    const keeper = report.machineId ? best.get(report.machineId) : undefined
    if (!keeper || keeper === report) return report
    return { ...report, found: [], envUrls: [], duplicateOf: keeper.server }
  })
}

export type DiscoverResult = { reports: ServerReport[]; skipped: SkippedServer[] }

/** Probes the chosen servers, a few at a time, in the order given. */
export async function discover(ctx: BaseContext, options: DiscoverOptions = {}): Promise<DiscoverResult> {
  if (!options.sqliteRoots) {
    const configured = (await ctx.settings.get<string>('sqliteRoots', '')).split(/[,\s]+/).filter(Boolean)
    if (configured.length) options = { ...options, sqliteRoots: configured }
  }
  const known = (await ctx.servers?.list()) ?? []
  const named = Boolean(options.servers?.length)
  const picked = named ? { chosen: known, skipped: [] } : pickServers(known)
  const wanted = named ? options.servers!.filter((name) => name !== LOCAL_SERVER) : picked.chosen.map((server) => server.name)
  const missing = wanted.filter((name) => !known.some((server) => server.name === name))
  if (missing.length) {
    throw new Error(`No server called ${missing.join(', ')}. See: diskpush fleet servers`)
  }
  const targets: Array<{ name: string; server: ServerRef | null }> = []
  if (options.local || options.servers?.includes(LOCAL_SERVER)) targets.push({ name: LOCAL_SERVER, server: null })
  for (const name of wanted) targets.push({ name, server: known.find((server) => server.name === name)! })
  if (!targets.length) throw new Error('No servers to look on. Add one with: diskpush connections add, or pass --local.')

  const reports: ServerReport[] = new Array(targets.length)
  let next = 0
  let done = 0
  ctx.progress.start(targets.length)
  const worker = async () => {
    while (next < targets.length && !ctx.signal.aborted) {
      const index = next++
      const target = targets[index]!
      ctx.progress.update({ message: `Looking for databases on ${target.name}…` })
      reports[index] = await probeServer(ctx, target.name, target.server, options)
      ctx.progress.update({ done: ++done, total: targets.length })
    }
  }
  const lanes = Math.max(1, Math.min(options.concurrency ?? PROBE_DEFAULTS.concurrency, targets.length))
  await Promise.all(Array.from({ length: lanes }, worker))
  return { reports: mergeSameMachine(reports.filter(Boolean)), skipped: picked.skipped }
}

export type Reconciled = {
  found: Found
  /** The saved database it already is, or the name it would be saved as. */
  name: string
  saved: boolean
}

/** Matches found databases against the saved list; new ones get a name. Also returns saved ones a reachable server no longer has. */
export function reconcile(reports: readonly ServerReport[], saved: readonly DatabaseConfig[]): { rows: Reconciled[]; vanished: DatabaseConfig[] } {
  const taken = new Set(saved.map((db) => db.name))
  const rows: Reconciled[] = []
  const seen = new Set<string>()
  for (const report of reports) {
    for (const found of report.found) {
      const existing = saved.find((db) => sameDatabase(db, found))
      if (existing) {
        seen.add(existing.name)
        rows.push({ found, name: existing.name, saved: true })
      } else {
        const name = suggestName(found, taken)
        taken.add(name)
        rows.push({ found, name, saved: false })
      }
    }
  }
  const probed = new Set(reports.filter((report) => report.ok).map((report) => report.server))
  const vanished = saved.filter((db) => db.server && probed.has(db.server) && !seen.has(db.name))
  return { rows, vanished }
}

/** Saves the new rows. Returns what was added. */
export async function saveFound(
  ctx: BaseContext,
  rows: readonly Reconciled[],
  defaults: Pick<DatabaseConfig, 'tags' | 'push' | 'keepLast' | 'keepDays'>,
): Promise<DatabaseConfig[]> {
  const current = await loadDatabases(ctx)
  const added = rows.filter((row) => !row.saved && !current.some((db) => db.name === row.name)).map((row) => toConfig(row.found, row.name, defaults))
  if (added.length) await saveDatabases(ctx, [...current, ...added])
  return added
}
