/**
 * The cleaner end to end: the real scan and apply programs run in a real
 * shell against a fixture home, with docker, npm, journalctl, crontab and
 * pgrep replaced by shims on PATH so nothing on the machine running the
 * tests is looked at or touched.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Every test runs the real programs in a real shell: seconds, not milliseconds.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })
import type { BaseContext } from '@diskpush/plugin-api'
import { applyClean, scanTarget, sshArgs, type CleanOptions } from './api.js'
import { serveMcp } from './mcp.js'
import { classifyDir, dockerTime, parseDockerSize, growthSince, parseCategories } from './model.js'
import { applyScript, scanScript, DEFAULT_SCRIPT_OPTIONS } from './script.js'

const base = mkdtempSync(join(tmpdir(), 'diskpush-cleaner-test-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const OLD = (Date.now() - 10 * 86400_000) / 1000

function write(path: string, content: string | Buffer = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** Every file and directory under `dir` gets an mtime 10 days ago. */
function age(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) age(path)
    utimesSync(path, OLD, OLD)
  }
  utimesSync(dir, OLD, OLD)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-C', cwd, ...args], { stdio: 'ignore' })
}

function project(dir: string, options: { builds: string[]; ignore?: string[]; cargo?: boolean }): void {
  write(join(dir, options.cargo ? 'Cargo.toml' : 'package.json'), options.cargo ? '[package]\nname="x"\n' : '{}')
  write(join(dir, 'src', 'index.js'), 'console.log(1)')
  write(join(dir, '.gitignore'), `${(options.ignore ?? options.builds).join('\n')}\n`)
  for (const build of options.builds) write(join(dir, build, 'blob.bin'), Buffer.alloc(64 * 1024, 1))
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '.gitignore', 'src')
}

let n = 0
type Fixture = { home: string; shims: string; calls: string; log: string; lock: string; ctx: BaseContext; options: CleanOptions }

function shim(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

/** A fresh home with every case the guards must tell apart. */
function fixture(): Fixture {
  const root = join(base, `f${++n}`)
  const home = join(root, 'home')
  const shims = join(root, 'bin')
  const calls = join(root, 'calls.txt')
  const log = join(root, 'log')
  mkdirSync(shims, { recursive: true })
  writeFileSync(calls, '')

  const src = join(home, 'src')
  project(join(src, 'idle'), { builds: ['node_modules', '.next', 'dist'] })
  project(join(src, 'rusty'), { builds: ['target'], cargo: true })
  project(join(src, 'committed-dist'), { builds: ['node_modules', 'dist'], ignore: ['node_modules'] })
  project(join(src, 'active'), { builds: ['node_modules'] })
  project(join(src, 'busy'), { builds: ['node_modules'] })
  project(join(src, 'wired'), { builds: ['node_modules'] })
  write(join(src, 'not-a-project', 'node_modules', 'blob.bin'), Buffer.alloc(4096, 1))
  write(join(home, 'Downloads', 'dead.iso.partial'), Buffer.alloc(8192, 1))
  write(join(home, 'Downloads', 'fresh.iso.partial'), Buffer.alloc(8192, 1))
  write(join(home, '.npm', '_cacache', 'content', 'blob'), Buffer.alloc(16384, 1))
  write(join(log, 'app.log.1'), Buffer.alloc(1100 * 1024, 65))
  write(join(log, 'app.log'), Buffer.alloc(1100 * 1024, 65))
  for (const dir of ['idle', 'rusty', 'committed-dist', 'busy', 'wired', 'not-a-project']) age(join(src, dir))
  age(join(home, 'Downloads'))
  utimesSync(join(home, 'Downloads', 'fresh.iso.partial'), new Date(), new Date())
  age(log)
  utimesSync(join(log, 'app.log'), new Date(), new Date())

  shim(shims, 'docker', `echo "docker $*" >> '${calls}'
case "$1" in
  info) [ "$2" = --format ] && echo '${root}/docker'; exit 0 ;;
  system) echo '{"Images":[{"Containers":"0","CreatedAt":"2020-01-01 00:00:00 +0000 UTC","Size":"3GB","UniqueSize":"2GB"},{"Containers":"0","CreatedAt":"2999-01-01 00:00:00 +0000 UTC","Size":"1GB","UniqueSize":"1GB"},{"Containers":"1","CreatedAt":"2020-01-01 00:00:00 +0000 UTC","Size":"9GB"}],"Containers":[{"State":"exited","Size":"500MB"}],"Volumes":[{"Name":"app_pgdata","Links":"0","Size":"40GB"},{"Name":"used","Links":"1","Size":"1GB"}],"BuildCache":[{"InUse":"false","Size":"5GB"},{"InUse":"true","Size":"1GB"}]}' ;;
  ps) exit 0 ;;
  *) exit 0 ;;
esac`)
  shim(shims, 'npm', `echo "npm $*" >> '${calls}'
[ "$1 $2" = "cache clean" ] && rm -rf "$HOME/.npm/_cacache"
exit 0`)
  shim(shims, 'journalctl', `echo "journalctl $*" >> '${calls}'
[ "$1" = --disk-usage ] && echo "Archived and active journals take up 3.0G in the file system."
exit 0`)
  shim(shims, 'crontab', `[ "$1" = -l ] && echo "0 * * * * cd '${join(src, 'wired')}' && npm start"; exit 0`)
  shim(shims, 'pgrep', 'exit 1')
  shim(shims, 'sudo', 'exit 1')

  const settings = new Map<string, unknown>()
  const ctx: BaseContext = {
    settings: { get: async (key, fallback) => (settings.has(key) ? (settings.get(key) as never) : fallback), set: async (key, value) => void settings.set(key, value) },
    secrets: { get: async () => null, set: async () => {} },
    progress: { start() {}, update() {}, log() {} },
    openUrl: async () => {},
    signal: new AbortController().signal,
    surface: 'cli',
    env: { ...process.env, HOME: home, PATH: `${shims}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, npm_config_cache: '' },
  }
  const options: CleanOptions = {
    sampleSeconds: 0,
    buildRoots: [src],
    partialRoots: [home],
    topRoots: [home],
    logDir: log,
  }
  return { home, shims, calls, log, lock: join(root, 'lock'), ctx, options }
}

let f: Fixture
let busy: ChildProcess | null = null

beforeEach(() => {
  busy?.kill()
  f = fixture()
  // A process working inside "busy": its build output must stay.
  busy = spawn('sleep', ['60'], { cwd: join(f.home, 'src', 'busy'), stdio: 'ignore' })
  // "active" has a file changed just now.
  write(join(f.home, 'src', 'active', 'src', 'new.js'), 'x')
})
afterAll(() => busy?.kill())

const src = (...parts: string[]) => join(f.home, 'src', ...parts)

describe('scan', () => {
  it('finds exactly the eligible build output, partials, caches, docker and logs, and explains the rest', async () => {
    const report = await scanTarget(f.ctx, 'local', f.options)
    const eligible = report.items.filter((i) => i.eligible).map((i) => i.id).sort()
    expect(eligible).toEqual(
      [
        `build:${src('idle', '.next')}`,
        `build:${src('idle', 'dist')}`,
        `build:${src('idle', 'node_modules')}`,
        `build:${src('rusty', 'target')}`,
        `build:${src('committed-dist', 'node_modules')}`,
        'cache:npm',
        'docker:buildcache',
        'docker:images',
        `log:${join(f.log, 'app.log.1')}`,
        `partial:${join(f.home, 'Downloads', 'dead.iso.partial')}`,
      ].sort(),
    )
    const why = (path: string) => report.kept.find((k) => k.root === path || k.root === src(path))?.reason
    expect(why(src('active'))).toMatch(/changed in the last 3 days/)
    expect(why(src('busy'))).toMatch(/running process/)
    expect(why(src('wired'))).toMatch(/cron job/)
    expect(why(src('committed-dist', 'dist'))).toMatch(/not git-ignored/)
    // A node_modules outside any project is not even listed.
    expect(JSON.stringify(report)).not.toContain('not-a-project')
    const fresh = report.items.find((i) => i.id.endsWith('fresh.iso.partial'))!
    expect(fresh.eligible).toBe(false)
    expect(fresh.why).toMatch(/may still be in progress/)

    // Docker numbers: unused cache only, images older than 72h and unused only.
    expect(report.items.find((i) => i.id === 'docker:buildcache')!.bytes).toBe(5e9)
    expect(report.items.find((i) => i.id === 'docker:images')!.bytes).toBe(2e9)
    // Volumes, stopped containers and a journal that needs root are never eligible.
    const volume = report.items.find((i) => i.id === 'volume:app_pgdata')!
    expect(volume.safety).toBe('human')
    expect(volume.eligible).toBe(false)
    expect(volume.suggested).toContain('docker volume rm app_pgdata')
    expect(report.items.find((i) => i.id === 'volume:used')).toBeUndefined()
    expect(report.items.find((i) => i.id === 'docker:containers')!.eligible).toBe(false)
    expect(report.items.find((i) => i.id === 'journal')!.eligible).toBe(false)

    // Ranked: bytes per unit of risk, safe classes before humans.
    const scores = report.items.filter((i) => i.safety !== 'human').map((i) => i.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    expect(report.plan.ids[0]).toBe('docker:buildcache')
    expect(report.topDirs.map((d) => d.path)).toContain(join(f.home, 'src'))
  })

  it('remembers a snapshot and reports growth on the next full scan', async () => {
    const options = { ...f.options, phases: ['fs', 'top'] as const }
    const first = await scanTarget(f.ctx, 'local', { ...options, phases: [...options.phases] })
    expect(first.growth).toBeNull()
    write(join(f.home, 'src', 'grow.bin'), Buffer.alloc(512 * 1024, 1))
    await new Promise((r) => setTimeout(r, 1100))
    const second = await scanTarget(f.ctx, 'local', { ...options, phases: [...options.phases] })
    expect(second.growth).not.toBeNull()
    expect(second.growth!.dirs.find((d) => d.path === join(f.home, 'src'))!.deltaBytes).toBeGreaterThan(400 * 1024)
  })
})

describe('apply', () => {
  const survivors = () => [
    src('active', 'node_modules'),
    src('busy', 'node_modules'),
    src('wired', 'node_modules'),
    src('committed-dist', 'dist'),
    src('not-a-project', 'node_modules'),
    src('idle', 'src', 'index.js'),
    src('idle', 'package.json'),
    join(f.home, 'Downloads', 'fresh.iso.partial'),
    join(f.log, 'app.log'),
  ]

  it('a dry run deletes nothing and lists exactly the eligible set', async () => {
    const report = await scanTarget(f.ctx, 'local', f.options)
    const result = await applyClean(f.ctx, report, { apply: false, lockDir: f.lock })
    expect(result.dryRun).toBe(true)
    expect(result.results).toEqual([])
    expect(result.wouldRemove.map((i) => i.id).sort()).toEqual(report.items.filter((i) => i.eligible).map((i) => i.id).sort())
    for (const item of report.items) if (item.path && item.category !== 'docker') expect(existsSync(item.path), item.path).toBe(true)
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/prune|cache clean|vacuum/)
  })

  it('apply removes exactly the eligible set and nothing else', async () => {
    const report = await scanTarget(f.ctx, 'local', f.options)
    const result = await applyClean(f.ctx, report, { apply: true, lockDir: f.lock })
    expect(result.results.filter((r) => r.status !== 'ok')).toEqual([])
    for (const id of report.items.filter((i) => i.eligible && (i.category === 'build' || i.category === 'partials')).map((i) => i.path!)) {
      expect(existsSync(id), id).toBe(false)
    }
    for (const path of survivors()) expect(existsSync(path), path).toBe(true)
    expect(existsSync(join(f.log, 'app.log.1'))).toBe(false)
    expect(existsSync(join(f.log, 'app.log.1.gz'))).toBe(true)
    expect(existsSync(join(f.home, '.npm', '_cacache'))).toBe(false)
    const calls = readFileSync(f.calls, 'utf8')
    expect(calls).toContain('docker builder prune -f')
    expect(calls).toContain('docker image prune -a -f --filter until=72h')
    expect(calls).not.toMatch(/volume|docker rm|journalctl --vacuum/)
    expect(existsSync(f.lock)).toBe(false)
  })

  it('only touches the chosen categories', async () => {
    const report = await scanTarget(f.ctx, 'local', f.options)
    await applyClean(f.ctx, report, { apply: true, only: 'partials', lockDir: f.lock })
    expect(existsSync(join(f.home, 'Downloads', 'dead.iso.partial'))).toBe(false)
    expect(existsSync(src('idle', 'node_modules'))).toBe(true)
    expect(readFileSync(f.calls, 'utf8')).not.toContain('prune')
  })

  it('re-checks every guard at deletion time: a project that became active is skipped', async () => {
    const report = await scanTarget(f.ctx, 'local', { ...f.options, only: ['build'] })
    write(src('idle', 'src', 'touched.js'), 'now')
    const result = await applyClean(f.ctx, report, { apply: true, only: ['build'], lockDir: f.lock })
    const idle = result.results.filter((r) => r.id.includes('/idle/'))
    expect(idle.length).toBe(3)
    for (const r of idle) {
      expect(r.status).toBe('skipped')
      expect(r.message).toMatch(/changed in the last 3 days/)
    }
    expect(existsSync(src('idle', 'node_modules'))).toBe(true)
    expect(existsSync(src('rusty', 'target'))).toBe(false)
  })

  it('never runs two cleans at once', async () => {
    const report = await scanTarget(f.ctx, 'local', { ...f.options, only: ['partials'] })
    mkdirSync(f.lock)
    writeFileSync(join(f.lock, 'pid'), String(process.pid))
    const result = await applyClean(f.ctx, report, { apply: true, lockDir: f.lock })
    expect(result.locked).toBe(true)
    expect(existsSync(join(f.home, 'Downloads', 'dead.iso.partial'))).toBe(true)
  })

  it('threshold mode does nothing while enough space is free', async () => {
    const report = await scanTarget(f.ctx, 'local', { ...f.options, only: ['partials'] })
    const result = await applyClean(f.ctx, report, { apply: true, minFreeGb: 0.0001, lockDir: f.lock })
    expect(result.stopped).toBe(true)
    expect(result.results).toEqual([])
    expect(existsSync(join(f.home, 'Downloads', 'dead.iso.partial'))).toBe(true)
  })
})

describe('mcp', () => {
  it('lists the tools and treats clean_apply without apply: true as a dry run', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk) => (text += chunk))
    const ctx = { ...f.ctx, settings: f.ctx.settings }
    // Route the MCP scans through the fixture's roots.
    const served = serveMcp(ctx, input, output, { version: 'test' }, async (server, script, opts) => {
      const { defaultRunner } = await import('./api.js')
      return defaultRunner(server, script.replace(/^build_roots\(\).*$/m, `build_roots() { printf '%s\\n' '${src()}'; }`).replace(/^partial_roots\(\).*$/m, `partial_roots() { printf '%s\\n' '${f.home}'; }`).replace(/^top_roots\(\).*$/m, `top_roots() { printf '%s\\n' '${f.home}'; }`).replace(/^LOG_DIR=.*$/m, `LOG_DIR='${f.log}'`), opts)
    })
    const send = (message: object) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    send({ id: 3, method: 'tools/call', params: { name: 'clean_apply', arguments: { only: ['build', 'partials'], sampleSeconds: 0 } } })
    input.end()
    await served
    const replies = text.trim().split('\n').map((line) => JSON.parse(line))
    expect(replies.find((r) => r.id === 1).result.serverInfo.name).toBe('diskpush-cleaner')
    expect(replies.find((r) => r.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(['clean_targets', 'clean_report', 'clean_apply'])
    const call = replies.find((r) => r.id === 3).result
    expect(call.isError).toBeUndefined()
    expect(call.structuredContent.dryRun).toBe(true)
    expect(call.structuredContent.wouldRemove.length).toBeGreaterThan(0)
    expect(call.content[0].text).toContain('apply: true')
    expect(existsSync(src('idle', 'node_modules'))).toBe(true)
  })
})

describe('pieces', () => {
  it('parses docker sizes and times', () => {
    expect(parseDockerSize('1.5GB (40%)')).toBe(1.5e9)
    expect(parseDockerSize('225kB')).toBe(225e3)
    expect(parseDockerSize('0B')).toBe(0)
    expect(dockerTime('2026-11-11 09:56:23 +0000 UTC')).toBe(Date.parse('2026-11-11T09:56:23Z') / 1000)
    expect(dockerTime('2026-11-11 09:49:27.393197051 +0100 CET')).toBe(Date.parse('2026-11-11T08:49:27Z') / 1000)
  })

  it('classifies big directories for a human', () => {
    expect(classifyDir('/srv/app/pgdata', null)).toBe('database')
    expect(classifyDir('/home/u/Backups', null)).toBe('backups')
    expect(classifyDir('/home/u/Videos', null)).toBe('media')
    expect(classifyDir('/var/lib/docker', null)).toBe('docker')
    expect(classifyDir('/home/u/src', null)).toBeNull()
  })

  it('computes growth between snapshots', () => {
    const growth = growthSince({ at: '2026-01-01T00:00:00Z', fs: { '/': 100 }, dirs: { '/a': 10 } }, { at: '2026-01-01T01:00:00Z', fs: { '/': 3700 }, dirs: { '/a': 30 } })
    expect(growth!.fs[0]).toEqual({ mount: '/', deltaBytes: 3600, bytesPerHour: 3600 })
    expect(growth!.dirs[0]).toEqual({ path: '/a', deltaBytes: 20 })
  })

  it('rejects unknown categories and bad option values', () => {
    expect(parseCategories('cache,build')).toEqual(['caches', 'build'])
    expect(() => parseCategories('volumes')).toThrow(/not a category/)
    expect(() => scanScript({ ...DEFAULT_SCRIPT_OPTIONS, imageAge: '1; rm -rf /' })).toThrow(/not valid/)
  })

  it('quotes every path it is handed', () => {
    const script = applyScript({ ...DEFAULT_SCRIPT_OPTIONS, stopAtKb: 0, stopPath: '/' }, [{ kind: 'build', id: 'build:x', path: "/a/it's $(reboot)/node_modules" }])
    expect(script).toContain(`go && do_build build:x '/a/it'\\''s $(reboot)/node_modules'`)
  })

  it('builds a non-interactive ssh command', () => {
    const args = sshArgs({ name: 'box', host: 'box.example', port: 2222, username: 'me', keyPath: null, jumpHost: null, sshConfigAlias: null, passwordAuth: false })
    expect(args).toContain('BatchMode=yes')
    expect(args.slice(-4)).toEqual(['2222', 'me@box.example', '--', 'sh -s'])
  })
})
