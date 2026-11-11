/**
 * The one core every surface calls: CLI, TUI, desktop and MCP.
 *
 *   listTargets(ctx)               this machine plus every server DiskPush knows
 *   scanTarget(ctx, target, opts)  read-only: a Report (always a dry run)
 *   applyClean(ctx, report, opts)  deletes the chosen eligible items, re-checking each on the target
 *
 * A target is `local` (run in a local shell) or a server name from the host's
 * server directory (run over the system ssh, BatchMode, so nothing ever waits
 * on a password prompt). The programs themselves are in script.ts.
 */
import { spawn } from 'node:child_process'
import type { BaseContext, ServerRef } from '@diskpush/plugin-api'
import {
  buildReport,
  parseCategories,
  parseRecords,
  selectSteps,
  type CleanCategory,
  type Report,
  type Snapshot,
} from './model.js'
import { ALL_PHASES, DEFAULT_SCRIPT_OPTIONS, applyScript, scanScript, type ApplyStep, type Phase, type ScriptOptions } from './script.js'

export const LOCAL_TARGET = 'local'

export type Target = { name: string; local: boolean; host: string | null; usable: boolean; reason: string | null }

export async function listTargets(ctx: Pick<BaseContext, 'servers'>): Promise<Target[]> {
  const targets: Target[] = [{ name: LOCAL_TARGET, local: true, host: null, usable: true, reason: null }]
  for (const server of (await ctx.servers?.list()) ?? []) {
    targets.push({
      name: server.name,
      local: false,
      host: server.host,
      usable: !server.passwordAuth,
      reason: server.passwordAuth ? 'signs in with a password; the cleaner needs a key or an agent' : null,
    })
  }
  return targets
}

async function resolveTarget(ctx: Pick<BaseContext, 'servers'>, name: string): Promise<ServerRef | null> {
  if (name === LOCAL_TARGET || name === 'localhost') return null
  if (!ctx.servers) throw new Error(`This DiskPush cannot reach servers from here, so "${name}" is out of reach.`)
  const server = (await ctx.servers.list()).find((candidate) => candidate.name === name)
  if (!server) throw new Error(`No server called "${name}". See: diskpush fleet servers`)
  if (server.passwordAuth) throw new Error(`${name} signs in with a password; the cleaner needs a key or an agent.`)
  return server
}

export type SshOptions = { knownHostsFiles?: readonly string[]; sshConfigFile?: string | null; connectTimeoutSeconds?: number }

/** `ssh` argv that runs `sh -s` on the server, never prompting for anything. */
export function sshArgs(server: ServerRef, options: SshOptions = {}): string[] {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${options.connectTimeoutSeconds ?? 20}`, '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6']
  if (options.knownHostsFiles?.length) args.push('-o', `UserKnownHostsFile=${options.knownHostsFiles.map((file) => `"${file}"`).join(' ')}`)
  if (options.sshConfigFile) args.push('-F', options.sshConfigFile)
  if (server.sshConfigAlias) {
    args.push(server.sshConfigAlias)
  } else {
    args.push('-p', String(server.port))
    if (server.keyPath) args.push('-i', server.keyPath, '-o', 'IdentitiesOnly=yes')
    if (server.jumpHost) args.push('-J', server.jumpHost)
    args.push(server.username ? `${server.username}@${server.host}` : server.host)
  }
  args.push('--', 'sh -s')
  return args
}

export type RunResult = { code: number; stdout: string; stderr: string }

/** How a program is run; replaced in tests. */
export type Runner = (
  server: ServerRef | null,
  script: string,
  options: { signal: AbortSignal; env: Readonly<Record<string, string | undefined>>; ssh: SshOptions; onLine?: (line: string) => void },
) => Promise<RunResult>

/** Local process groups still running, stopped if this process exits first (a second Ctrl+C). */
const liveGroups = new Set<number>()
let exitHook = false
function trackGroup(pid: number | undefined): void {
  if (!pid) return
  liveGroups.add(pid)
  if (exitHook) return
  exitHook = true
  process.once('exit', () => {
    for (const group of liveGroups) {
      try {
        process.kill(-group, 'SIGTERM')
      } catch {
        // gone
      }
    }
  })
}

export const defaultRunner: Runner = (server, script, options) =>
  new Promise((resolve, reject) => {
    const program = server ? (options.env.DISKPUSH_SSH ?? 'ssh') : '/bin/sh'
    const args = server ? sshArgs(server, options.ssh) : ['-s']
    // Its own process group, so a cancel stops the du and find it started too, not just the shell.
    const child = spawn(program, args, { cwd: '/', env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: !server })
    const stop = () => {
      try {
        if (!server && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
    if (!server) trackGroup(child.pid)
    if (options.signal.aborted) stop()
    options.signal.addEventListener('abort', stop, { once: true })
    let stdout = ''
    let stderr = ''
    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!options.onLine) return
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) options.onLine(line)
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', (error) => {
      options.signal.removeEventListener('abort', stop)
      reject(error)
    })
    child.on('close', (code) => {
      if (child.pid) liveGroups.delete(child.pid)
      options.signal.removeEventListener('abort', stop)
      resolve({ code: options.signal.aborted ? 130 : (code ?? 1), stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(script)
  })

export type CleanOptions = {
  idleDays?: number
  partialHours?: number
  sampleSeconds?: number
  duTimeoutSeconds?: number
  buildRoots?: string[]
  partialRoots?: string[]
  topRoots?: string[]
  logDir?: string
  journalCap?: string
  imageAge?: string
  useSudo?: boolean
  /** Only scan for these categories (plus the disk report, unless `phases` says otherwise). */
  only?: CleanCategory[]
  phases?: Phase[]
  minFreeGb?: number
  /** Persist and compare a snapshot for growth (default true for a full scan). */
  snapshot?: boolean
  runner?: Runner
}

const CATEGORY_PHASE: Record<CleanCategory, Phase> = { caches: 'caches', docker: 'docker', logs: 'logs', build: 'build', partials: 'partials' }

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

/** Saved settings under the options given now. */
export async function resolveOptions(ctx: Pick<BaseContext, 'settings'>, options: CleanOptions): Promise<ScriptOptions & { minFreeBytes: number }> {
  const s = ctx.settings
  const number = async (key: string, given: number | undefined, fallback: number) => {
    if (given !== undefined) return given
    const saved = Number(await s.get(key, String(fallback)))
    return Number.isFinite(saved) && saved >= 0 ? Math.floor(saved) : fallback
  }
  const phases = options.phases ?? (options.only?.length ? ['fs', 'top', 'writers', ...options.only.map((c) => CATEGORY_PHASE[c])] : [...ALL_PHASES])
  return {
    ...DEFAULT_SCRIPT_OPTIONS,
    idleDays: await number('idleDays', options.idleDays, DEFAULT_SCRIPT_OPTIONS.idleDays),
    partialHours: await number('partialHours', options.partialHours, DEFAULT_SCRIPT_OPTIONS.partialHours),
    sampleSeconds: options.sampleSeconds ?? DEFAULT_SCRIPT_OPTIONS.sampleSeconds,
    duTimeoutSeconds: options.duTimeoutSeconds ?? DEFAULT_SCRIPT_OPTIONS.duTimeoutSeconds,
    buildRoots: options.buildRoots ?? list(await s.get('buildRoots', '')),
    partialRoots: options.partialRoots ?? list(await s.get('partialRoots', '')),
    topRoots: options.topRoots ?? [],
    logDir: options.logDir ?? DEFAULT_SCRIPT_OPTIONS.logDir,
    journalCap: options.journalCap ?? (await s.get('journalCap', DEFAULT_SCRIPT_OPTIONS.journalCap)),
    imageAge: options.imageAge ?? (await s.get('imageAge', DEFAULT_SCRIPT_OPTIONS.imageAge)),
    useSudo: options.useSudo ?? (await s.get('useSudo', false)),
    phases: [...new Set(phases)],
    minFreeBytes: Math.max(0, (options.minFreeGb ?? 0) * 1024 ** 3),
  }
}

function snapshotKey(target: string): string {
  return `snapshot.${target.replace(/[^A-Za-z0-9_.-]/g, '_')}`
}

function sshOptions(ctx: Pick<BaseContext, 'servers'>): SshOptions {
  return { knownHostsFiles: ctx.servers?.knownHostsFiles ?? [], sshConfigFile: ctx.servers?.sshConfigFile ?? null }
}

/** Read-only. Scans the target and returns the report; deletes nothing. */
export async function scanTarget(ctx: BaseContext, target: string, options: CleanOptions = {}): Promise<Report> {
  const server = await resolveTarget(ctx, target)
  const resolved = await resolveOptions(ctx, options)
  const runner = options.runner ?? defaultRunner
  ctx.progress.update({ message: `Scanning ${target}…` })
  const result = await runner(server, scanScript(resolved), {
    signal: ctx.signal,
    env: ctx.env,
    ssh: sshOptions(ctx),
    onLine: (line) => {
      if (line.startsWith('STEP\t')) ctx.progress.update({ message: `${target}: ${line.slice(5)}` })
    },
  })
  if (ctx.signal.aborted) throw new Error('Cancelled.')
  if (server && result.code === 255 && !result.stdout) {
    throw new Error(`Could not reach ${target} over ssh: ${result.stderr.trim().split('\n').pop() ?? 'connection failed'}`)
  }
  const raw = parseRecords(result.stdout, { imageAge: resolved.imageAge })
  if (!raw.meta.uid && result.code !== 0) throw new Error(`The scan on ${target} failed: ${result.stderr.trim().slice(0, 500) || `exit ${result.code}`}`)
  const fullScan = resolved.phases.includes('fs') && resolved.phases.includes('top')
  const remember = options.snapshot ?? fullScan
  const previous = remember ? await ctx.settings.get<Snapshot | null>(snapshotKey(target), null) : null
  const report = buildReport(raw, {
    target,
    idleDays: resolved.idleDays,
    partialHours: resolved.partialHours,
    journalCap: resolved.journalCap,
    imageAge: resolved.imageAge,
    useSudo: resolved.useSudo,
    logDir: resolved.logDir,
    minFreeBytes: resolved.minFreeBytes,
    previous,
  })
  if (remember && raw.complete) await ctx.settings.set(snapshotKey(target), report.snapshot)
  return report
}

export type ItemResult = {
  id: string
  status: 'ok' | 'skipped' | 'failed' | 'not-needed'
  freedBytes: number
  /** False: free space did not visibly change, so freedBytes is the scan's estimate. */
  measured: boolean
  message: string
}

export type ApplyResult = {
  target: string
  dryRun: boolean
  locked: boolean
  /** The free-space goal was reached and the rest was left alone. */
  stopped: boolean
  results: ItemResult[]
  freedBytes: number
  /** In a dry run: what would be removed. */
  wouldRemove: { id: string; title: string; bytes: number }[]
}

export type ApplyChoice = {
  /** False: list what would be removed and delete nothing. */
  apply: boolean
  only?: CleanCategory[] | string
  ids?: string[]
  minFreeGb?: number
  useSudo?: boolean
  runner?: Runner
  /** Tests only. */
  lockDir?: string
}

/**
 * Removes the chosen eligible items of `report`. Never a `human` item, never
 * anything outside the categories, and every item is re-checked on the target
 * as it is removed. With `apply: false` it only says what would go.
 */
export async function applyClean(ctx: BaseContext, report: Report, choice: ApplyChoice): Promise<ApplyResult> {
  const only = typeof choice.only === 'string' ? parseCategories(choice.only) : (choice.only ?? [])
  const chosen = selectSteps(report, { only, ids: choice.ids ?? [] })
  const wouldRemove = chosen.map((i) => ({ id: i.id, title: i.title, bytes: i.bytes }))
  const base: ApplyResult = { target: report.target, dryRun: !choice.apply, locked: false, stopped: false, results: [], freedBytes: 0, wouldRemove }
  if (choice.minFreeGb && choice.minFreeGb > 0) {
    const fs = report.filesystems.find((f) => f.mount === report.homeMount) ?? report.filesystems.find((f) => f.mount === '/')
    if (fs && fs.availBytes >= choice.minFreeGb * 1024 ** 3) return { ...base, stopped: true, wouldRemove: [] }
  }
  if (!choice.apply || chosen.length === 0) return base

  const server = await resolveTarget(ctx, report.target)
  const resolved = await resolveOptions(ctx, {
    idleDays: report.idleDays,
    logDir: report.scan.logDir,
    imageAge: report.scan.imageAge,
    journalCap: report.scan.journalCap,
    partialHours: report.scan.partialHours,
    ...(choice.useSudo !== undefined ? { useSudo: choice.useSudo } : {}),
  })
  const minFreeKb = Math.max(0, Math.round((choice.minFreeGb ?? 0) * 1024 * 1024))
  const steps = chosen.map((i) => i.step!) as ApplyStep[]
  const script = applyScript(
    { ...resolved, stopAtKb: minFreeKb, stopPath: report.homeMount ?? report.home ?? '/', ...(choice.lockDir ? { lockDir: choice.lockDir } : {}) },
    steps,
  )
  ctx.progress.start(steps.length)
  let done = 0
  const runner = choice.runner ?? defaultRunner
  const result = await runner(server, script, {
    signal: ctx.signal,
    env: ctx.env,
    ssh: sshOptions(ctx),
    onLine: (line) => {
      if (line.startsWith('STEP\t')) ctx.progress.update({ message: line.slice(5) })
      if (line.startsWith('RESULT\t')) ctx.progress.update({ done: ++done, total: steps.length })
    },
  })
  const results: ItemResult[] = []
  const estimates = new Map(chosen.map((i) => [i.id, i.bytes]))
  let locked = false
  let stopped = false
  for (const line of result.stdout.split('\n')) {
    const f = line.split('\t')
    if (f[0] === 'LOCKED') locked = true
    if (f[0] === 'STOPPED') stopped = true
    if (f[0] === 'RESULT' && f[1]) {
      const before = Number(f[3]) || 0
      const after = Number(f[4]) || 0
      const status = f[2] === 'ok' || f[2] === 'failed' ? f[2] : 'skipped'
      // Free space before and after, on the item's filesystem. When that shows nothing (an item smaller
      // than the noise, or other writers at the same time), the scan's estimate stands in.
      const measured = Math.max(0, after - before) * 1024
      const estimate = Math.max(0, estimates.get(f[1]) ?? 0)
      results.push({ id: f[1], status, freedBytes: status === 'ok' ? measured || estimate : measured, measured: measured > 0 || status !== 'ok', message: f.slice(5).join('\t') })
    }
  }
  const reported = new Set(results.map((r) => r.id))
  for (const step of steps) {
    if (!reported.has(step.id)) {
      results.push({ id: step.id, status: stopped ? 'not-needed' : 'skipped', freedBytes: 0, measured: true, message: stopped ? 'enough space was free already' : locked ? 'another clean is running' : 'did not run' })
    }
  }
  if (!locked && result.code !== 0 && results.every((r) => r.status !== 'ok')) {
    const why = result.stderr.trim().slice(0, 500)
    if (why && !results.length) throw new Error(`The clean on ${report.target} failed: ${why}`)
  }
  return { ...base, locked, stopped, results, freedBytes: results.reduce((sum, r) => sum + r.freedBytes, 0) }
}
