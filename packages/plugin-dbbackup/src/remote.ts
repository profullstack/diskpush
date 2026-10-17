/**
 * Databases on servers: the dump runs ON the server, with the server's own
 * tools (inside the database's container, or as its OS user), and only the
 * dump's bytes come back over ssh. Nothing needs a database port open to
 * this machine, and no database password is ever copied here: a container is
 * entered with `docker exec`, a native install through its local socket.
 *
 * Everything here is pure: argv and shell text, testable without a server.
 */
import type { ServerDirectory, ServerRef } from '@diskpush/plugin-api'
import { MYSQLDUMP_FLAGS, pgDumpFlags, shq } from './engines.js'
import type { Kind } from './naming.js'

/** The synthetic server that is this machine: discovery and dumps run in a local shell. */
export const LOCAL_SERVER = 'local'

/**
 * How a command becomes the user it must run as on the server. Only these
 * exact prefixes are ever stored or run, whatever a probe or a hand-edited
 * setting says.
 */
export const RUN_AS = ['', 'sudo -n', 'sudo -n -u postgres', 'runuser -u postgres --'] as const
export type RunAs = (typeof RUN_AS)[number]

export function isRunAs(value: unknown): value is RunAs {
  return typeof value === 'string' && (RUN_AS as readonly string[]).includes(value)
}

/** The parts of a saved database that say where on its server it lives. */
export type RemoteDatabase = {
  name: string
  kind: Kind
  server?: string
  via?: 'docker' | 'native'
  container?: string
  database?: string
  dbUser?: string
  dbHost?: string
  port?: number
  path?: string
  runAs?: string
  dumpArgs?: string[]
}

export type SshOptions = {
  knownHostsFiles?: readonly string[]
  sshConfigFile?: string | null
  /** Trust a server seen for the first time (StrictHostKeyChecking=accept-new). Off: an unknown host fails. */
  acceptNew?: boolean
  connectTimeoutSeconds?: number
}

/**
 * `ssh` argv that runs `command` on `server` and never asks anything: no
 * password prompt, no host-key question (an unknown host fails unless
 * `acceptNew`), so a cron run can never hang on a terminal that is not there.
 */
export function sshArgs(server: ServerRef, command: string, options: SshOptions = {}): string[] {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${options.connectTimeoutSeconds ?? 20}`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=6',
  ]
  if (options.acceptNew) args.push('-o', 'StrictHostKeyChecking=accept-new')
  if (options.knownHostsFiles?.length) {
    args.push('-o', `UserKnownHostsFile=${options.knownHostsFiles.map((file) => `"${file}"`).join(' ')}`)
  }
  if (options.sshConfigFile) args.push('-F', options.sshConfigFile)
  if (server.sshConfigAlias) {
    args.push(server.sshConfigAlias)
  } else {
    args.push('-p', String(server.port))
    if (server.keyPath) args.push('-i', server.keyPath, '-o', 'IdentitiesOnly=yes')
    if (server.jumpHost) args.push('-J', server.jumpHost)
    args.push(server.username ? `${server.username}@${server.host}` : server.host)
  }
  args.push('--', command)
  return args
}

function prefix(runAs: string | undefined): string {
  if (!isRunAs(runAs ?? '')) throw new Error(`"${runAs}" is not a way DiskPush runs commands on a server.`)
  return runAs ? `${runAs} ` : ''
}

function words(list: readonly string[]): string {
  return list.map(shq).join(' ')
}

/**
 * The shell command that writes `db`'s dump to stdout on its server: a plain
 * SQL dump ending in the tool's trailer, or for SQLite the database file
 * itself (an online-backup copy that passed `PRAGMA quick_check`).
 */
export function remoteDumpCommand(db: RemoteDatabase): string {
  const extra = db.dumpArgs ?? []
  const run = prefix(db.runAs)
  if (db.kind === 'sqlite') {
    if (!db.path) throw new Error(`${db.name}: no SQLite file configured.`)
    const script = [
      't=$(mktemp /var/tmp/diskpush-dbbackup.XXXXXX) || exit 1',
      `trap 'rm -f "$t"' EXIT`,
      `sqlite3 ${shq(db.path)} ".backup $t" || exit 1`,
      `v=$(sqlite3 -readonly "$t" 'PRAGMA quick_check;')`,
      `[ "$v" = ok ] || { echo "the copy failed its integrity check: $v" >&2; exit 1; }`,
      'cat "$t"',
    ].join('\n')
    return `${run}sh -c ${shq(script)}`
  }
  if (!db.database) throw new Error(`${db.name}: no database name on its server.`)
  if (db.kind === 'mysql') {
    const dump = [
      ...(db.via === 'docker'
        ? ['P=$MYSQL_ROOT_PASSWORD', '[ -n "$P" ] || P=$MARIADB_ROOT_PASSWORD', 'export MYSQL_PWD="$P"']
        : []),
      'D=$(command -v mysqldump || command -v mariadb-dump) || { echo "no mysqldump or mariadb-dump" >&2; exit 127; }',
      `exec "$D" -uroot ${words([...MYSQLDUMP_FLAGS, ...extra, db.database])}`,
    ].join('\n')
    if (db.via === 'docker') {
      if (!db.container) throw new Error(`${db.name}: no container configured.`)
      return `${run}docker exec ${shq(db.container)} sh -c ${shq(dump)}`
    }
    return `${run}sh -c ${shq(dump)}`
  }
  const flags = [...pgDumpFlags(db.kind), ...extra]
  if (db.via === 'docker') {
    if (!db.container) throw new Error(`${db.name}: no container configured.`)
    const connect = [...(db.dbHost ? ['-h', db.dbHost] : []), '-U', db.dbUser ?? 'postgres']
    return `${run}docker exec ${shq(db.container)} pg_dump ${words([...connect, ...flags, '-d', db.database])}`
  }
  const port = db.port ? ['-p', String(db.port)] : []
  return `${run}pg_dump ${words([...port, ...flags, '-d', db.database])}`
}

/** A saved database's server, from the host's directory; `local` is this machine. */
export async function findServer(servers: ServerDirectory | undefined, name: string): Promise<ServerRef | null> {
  if (name === LOCAL_SERVER) return null
  if (!servers) throw new Error(`This DiskPush cannot reach servers from here, so ${name} is out of reach.`)
  const server = (await servers.list()).find((candidate) => candidate.name === name)
  if (!server) throw new Error(`No server called "${name}". See: diskpush fleet servers`)
  if (server.passwordAuth) throw new Error(`${name} signs in with a password; database backups need a key or an agent.`)
  return server
}

/** Program and argv that run `command` on `server`, or in a local shell for `local`. */
export function commandOn(
  server: ServerRef | null,
  command: string,
  ssh: string,
  options: SshOptions = {},
): { program: string; args: string[] } {
  return server ? { program: ssh, args: sshArgs(server, command, options) } : { program: '/bin/sh', args: ['-c', command] }
}

/** Where a remote database is, for a listing: `dev2 docker:app-db-1/app`. */
export function describeRemote(db: RemoteDatabase): string {
  const where = db.kind === 'sqlite' ? db.path : db.via === 'docker' ? `docker:${db.container}/${db.database}` : `native${db.port ? `:${db.port}` : ''}/${db.database}`
  return `${db.server} ${where}`
}
