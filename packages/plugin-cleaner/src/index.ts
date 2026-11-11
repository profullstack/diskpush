/**
 * Cleaner: free disk space intelligently.
 *
 * First it finds what is actually using and growing the disk (filesystems,
 * the biggest directories, which processes are writing right now, growth
 * since the last report), then classifies every finding as safe
 * (regenerable), safe-if-idle, or needs-a-human, ranks them by bytes freed per
 * unit of risk, explains each one, and proposes a plan. Only the safe classes
 * are ever removed, only on an explicit apply, and every guard is checked
 * again at the moment of deleting. Works on this machine or any server
 * DiskPush can ssh to.
 *
 * Surfaces:
 *   CLI      diskpush clean report|run|targets|cron|mcp   (`clean` is short for `cleaner`)
 *   MCP      diskpush clean mcp: clean_targets, clean_report, clean_apply
 *   TUI      `a` on a directory: "Disk report: what can be freed here"
 *   desktop  the Cleaner tab (targets, report, select + apply with confirm); the same right-click action
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { definePlugin, type ActionResult, type CommandContext, type DiskpushPlugin } from '@diskpush/plugin-api'
import { applyClean, listTargets, scanTarget, LOCAL_TARGET, type CleanOptions } from './api.js'
import { formatApply, formatReport } from './format.js'
import { serveMcp } from './mcp.js'
import { CLEAN_CATEGORIES, formatBytes, parseCategories } from './model.js'
import type { Phase } from './script.js'

export * from './api.js'
export * from './format.js'
export * from './mcp.js'
export * from './model.js'
export { ALL_PHASES, BUILD_NAMES, CACHE_IDS, DEFAULT_SCRIPT_OPTIONS, applyScript, scanScript, shq, type ApplyStep, type Phase, type ScriptOptions } from './script.js'

const PACKAGE_VERSION: string = createRequire(import.meta.url)('../package.json').version

export const CLEANER_ID = 'cleaner'

class UsageError extends Error {}

/** `--flag`, `--key value`, `--key=value`, positionals. Unknown flags are an error: a typo never deletes by default. */
export function parseArgs(args: readonly string[], spec: { values?: string[]; flags?: string[] }) {
  const values = new Map<string, string>()
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
    if (spec.flags?.includes(key) && eq === -1) flags.add(key)
    else if (spec.values?.includes(key)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
      if (value === undefined) throw new UsageError(`--${key} needs a value.`)
      values.set(key, value)
    } else throw new UsageError(`Unknown option --${key}.`)
  }
  return { positional, flag: (key: string) => flags.has(key), value: (key: string) => values.get(key) }
}

function wholeNumber(text: string | undefined, name: string, min = 0): number | undefined {
  if (text === undefined) return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value < min) throw new UsageError(`--${name} takes a number of ${min} or more.`)
  return value
}

const SCAN_VALUES = ['only', 'idle-days', 'sample', 'roots', 'image-age', 'journal-cap', 'du-timeout', 'min-free-gb']

function scanOptions(a: ReturnType<typeof parseArgs>, cwd: string): CleanOptions {
  const only = parseCategories(a.value('only'))
  const roots = a.value('roots')?.split(',').map((r) => r.trim()).filter(Boolean).map((r) => (r.startsWith('~') ? r : resolve(cwd, r)))
  const idleDays = wholeNumber(a.value('idle-days'), 'idle-days', 1)
  const sample = wholeNumber(a.value('sample'), 'sample')
  const duTimeout = wholeNumber(a.value('du-timeout'), 'du-timeout', 1)
  const minFreeGb = wholeNumber(a.value('min-free-gb'), 'min-free-gb')
  return {
    ...(only.length ? { only } : {}),
    ...(idleDays !== undefined ? { idleDays: Math.floor(idleDays) } : {}),
    ...(sample !== undefined ? { sampleSeconds: Math.min(60, Math.floor(sample)) } : {}),
    ...(duTimeout !== undefined ? { duTimeoutSeconds: Math.floor(duTimeout) } : {}),
    ...(roots?.length ? { buildRoots: roots, partialRoots: roots } : {}),
    ...(a.value('image-age') ? { imageAge: a.value('image-age')! } : {}),
    ...(a.value('journal-cap') ? { journalCap: a.value('journal-cap')! } : {}),
    ...(a.flag('sudo') ? { useSudo: true } : {}),
    ...(minFreeGb ? { minFreeGb } : {}),
  }
}

function fail(ctx: CommandContext, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (ctx.json) ctx.printJson({ ok: false, error: message })
  else ctx.warn(message)
  return error instanceof UsageError ? 2 : 1
}

export function createCleanerPlugin(): DiskpushPlugin {
  return definePlugin({
    id: CLEANER_ID,
    name: 'Cleaner',
    version: PACKAGE_VERSION,
    description:
      'Find what is filling a disk (biggest directories, live writers, growth) and free space safely: caches, docker build cache, old unused images, rotated logs, idle build output, stale partial files. Dry run by default; databases, backups and volumes are only ever reported.',
    settings: [
      { key: 'idleDays', label: 'Idle days', description: 'Build output is removed only from projects with no changed file for this many days.', type: 'string', default: '3' },
      { key: 'buildRoots', label: 'Project folders', description: 'Comma-separated folders searched for projects. Empty: ~/src, ~/code, ~/projects, ~/dev, ~/work, ~/repos, ~/git, ~/worktrees, ~/scratch, ~/Developer.', type: 'string', default: '' },
      { key: 'partialRoots', label: 'Partial-file folders', description: 'Comma-separated folders searched for stale *.partial / *.part / *.crdownload files. Empty: your home folder.', type: 'string', default: '' },
      { key: 'imageAge', label: 'Docker image age', description: 'Unused docker images newer than this stay (so a deploy can roll back), e.g. 72h.', type: 'string', default: '72h' },
      { key: 'journalCap', label: 'Journal size cap', description: 'systemd journal vacuum target, e.g. 1G.', type: 'string', default: '1G' },
      { key: 'useSudo', label: 'Use passwordless sudo', description: 'Let docker, journald and system-log steps use `sudo -n` when it works.', type: 'boolean', default: false },
    ],
    actions: [
      {
        id: 'disk-report',
        label: 'Disk report: what can be freed here',
        description: 'Sizes this folder\'s contents and finds idle build output and stale partial files under it. Read-only.',
        tuiKey: 'f',
        appliesTo: (entries) => entries.length === 1 && entries[0]!.isDirectory,
        async run(ctx): Promise<ActionResult> {
          const path = resolve(ctx.dir, ctx.names[0]!)
          const report = await scanTarget(ctx, LOCAL_TARGET, {
            phases: ['top', 'build', 'partials'],
            topRoots: [path],
            buildRoots: [path],
            partialRoots: [path],
            sampleSeconds: 0,
            snapshot: false,
          })
          for (const line of formatReport(report, { limit: 15 })) if (line) ctx.progress.log('info', line)
          const n = report.plan.ids.length
          return {
            ok: true,
            message: n
              ? `${formatBytes(report.plan.bytes)} can be freed safely in ${n} item${n === 1 ? '' : 's'} under ${path}. To remove them: diskpush clean run --roots '${path}' --only build,partials --apply`
              : `Nothing under ${path} can be freed safely right now.`,
          }
        },
      },
    ],
    commands: [
      {
        name: 'report',
        summary: 'read-only: what fills the disk, what is growing, who is writing, and what can be freed safely (ranked, with reasons)',
        usage: 'report [TARGET] [--only caches,docker,logs,build,partials] [--idle-days 3] [--sample 3] [--roots DIR,DIR] [--sudo] [--all]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: SCAN_VALUES, flags: ['sudo', 'all', 'brief'] })
            const target = a.positional[0] ?? LOCAL_TARGET
            const report = await scanTarget(ctx, target, scanOptions(a, ctx.cwd))
            if (ctx.json) ctx.printJson(report)
            else for (const line of formatReport(report, { limit: a.flag('all') ? Infinity : 25, why: !a.flag('brief') })) ctx.print(line)
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'run',
        summary: 'free space: a dry run listing exactly what would go, unless --apply; only safe, eligible items',
        usage: 'run [TARGET] [--apply] [--only caches,docker,logs,build,partials] [--ids ID,ID] [--idle-days 3] [--min-free-gb N] [--roots DIR,DIR] [--sudo]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: [...SCAN_VALUES, 'ids'], flags: ['apply', 'sudo', 'all', 'yes'] })
            const target = a.positional[0] ?? LOCAL_TARGET
            const options = scanOptions(a, ctx.cwd)
            // A run needs the findings, not the disk report: skip sizing the top directories and watching writers.
            const phases = ['fs', ...(options.only?.length ? options.only : CLEAN_CATEGORIES)] as Phase[]
            const report = await scanTarget(ctx, target, { ...options, phases, snapshot: false })
            const ids = a.value('ids')?.split(',').map((id) => id.trim()).filter(Boolean)
            const result = await applyClean(ctx, report, {
              apply: a.flag('apply'),
              ...(options.only ? { only: options.only } : {}),
              ...(ids?.length ? { ids } : {}),
              ...(options.minFreeGb ? { minFreeGb: options.minFreeGb } : {}),
              ...(options.useSudo ? { useSudo: true } : {}),
            })
            const titles = new Map(report.items.map((i) => [i.id, i.title]))
            if (ctx.json) ctx.printJson(result)
            else for (const line of formatApply(result, titles)) ctx.print(line)
            if (result.locked) return 75
            return result.results.some((r) => r.status === 'failed') ? 1 : 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'targets',
        summary: 'the machines the cleaner can work on: local and every server DiskPush knows',
        usage: 'targets',
        async run(_args, ctx) {
          const targets = await listTargets(ctx)
          if (ctx.json) ctx.printJson(targets)
          else for (const t of targets) ctx.print(`  ${t.name.padEnd(24)} ${t.local ? 'this machine' : t.host ?? ''}${t.usable ? '' : `  (${t.reason})`}`)
          return 0
        },
      },
      {
        name: 'cron',
        summary: 'print a crontab line that cleans when free space drops below a threshold (two runs never overlap)',
        usage: 'cron [TARGET] [--min-free-gb 20] [--at "*/15 * * * *"] [--only caches,docker,logs,build,partials]',
        async run(args, ctx) {
          try {
            const a = parseArgs(args, { values: ['min-free-gb', 'at', 'only', 'idle-days'] })
            const at = a.value('at') ?? '*/15 * * * *'
            if (at.trim().split(/\s+/).length !== 5) throw new UsageError('--at takes a five-field cron schedule.')
            const gb = wholeNumber(a.value('min-free-gb') ?? '20', 'min-free-gb', 1)!
            const only = parseCategories(a.value('only'))
            const target = a.positional[0]
            if (target && !/^[A-Za-z0-9_.@-]+$/.test(target)) throw new UsageError('That target name cannot go in a crontab line.')
            const command = ['diskpush', 'clean', 'run', ...(target ? [target] : []), '--apply', '--min-free-gb', String(gb), ...(only.length ? ['--only', only.join(',')] : []), ...(a.value('idle-days') ? ['--idle-days', String(wholeNumber(a.value('idle-days'), 'idle-days', 1))] : []), '--quiet'].join(' ')
            const line = `${at} mkdir -p "$HOME/.local/state" && ${command} >> "$HOME/.local/state/diskpush-clean.log" 2>&1`
            if (ctx.json) ctx.printJson({ line })
            else {
              ctx.print('# Add with: crontab -e   (it does nothing while enough space is free; a lock keeps runs from overlapping)')
              ctx.print(`PATH=${ctx.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`)
              ctx.print(line)
            }
            return 0
          } catch (error) {
            return fail(ctx, error)
          }
        },
      },
      {
        name: 'mcp',
        summary: 'serve the cleaner over MCP on stdio (tools: clean_targets, clean_report, clean_apply)',
        usage: 'mcp',
        async run(_args, ctx) {
          // stdout belongs to the protocol from here on; progress would corrupt it.
          const quiet = { ...ctx, progress: { start() {}, update() {}, log() {} } }
          await serveMcp(quiet, process.stdin, process.stdout, { version: PACKAGE_VERSION })
          return 0
        },
      },
    ],
  })
}

export const cleanerPlugin = createCleanerPlugin()
export default cleanerPlugin

/** For hosts that want the categories without importing the model. */
export const CATEGORIES = CLEAN_CATEGORIES
