/** The report as text, for the CLI, the TUI's job log and MCP. */
import type { ApplyResult } from './api.js'
import { formatBytes, type Item, type Report } from './model.js'

const SAFETY_LABEL: Record<Item['safety'], string> = { safe: 'safe', 'safe-if-idle': 'safe-if-idle', human: 'needs-a-human' }

function size(item: Item): string {
  return `${item.upTo && item.bytes > 0 ? '≤' : ''}${formatBytes(item.bytes)}`.padStart(9)
}

function ago(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86400 * 2) return `${(seconds / 3600).toFixed(1)} h`
  return `${Math.round(seconds / 86400)} days`
}

export function formatReport(report: Report, options: { limit?: number; why?: boolean } = {}): string[] {
  const limit = options.limit ?? 25
  const why = options.why ?? true
  const out: string[] = [`Disk report for ${report.target} (dry run: nothing was deleted)`, '']

  if (report.filesystems.length) {
    out.push('Filesystems')
    for (const f of report.filesystems.slice(0, 8)) {
      const grow = report.growth?.fs.find((g) => g.mount === f.mount)
      const trend = grow && grow.deltaBytes !== 0 ? `   ${grow.deltaBytes > 0 ? '+' : '-'}${formatBytes(Math.abs(grow.deltaBytes))} in ${ago(report.growth!.seconds)} (${grow.bytesPerHour >= 0 ? '+' : '-'}${formatBytes(Math.abs(grow.bytesPerHour))}/h)` : ''
      out.push(`  ${f.mount.padEnd(24)} ${String(f.usedPercent).padStart(3)}% used  ${formatBytes(f.availBytes).padStart(9)} free of ${formatBytes(f.sizeBytes)}${trend}`)
    }
    out.push('')
  }

  if (report.writers.length) {
    out.push('Writing to disk right now')
    for (const w of report.writers.slice(0, 8)) {
      out.push(`  ${`${formatBytes(w.bytesPerSecond)}/s`.padStart(11)}  ${w.command}${w.container ? ` (container ${w.container})` : ''}  pid ${w.pid}`)
    }
    out.push('')
  }

  if (report.topDirs.length) {
    out.push('Biggest directories')
    for (const d of report.topDirs.slice(0, 12)) {
      const grown = report.growth?.dirs.find((g) => g.path === d.path)
      out.push(`  ${(d.bytes < 0 ? '?' : `${d.timedOut ? '≥' : ''}${formatBytes(d.bytes)}`).padStart(10)}  ${d.path}${d.kind ? `  [${d.kind}]` : ''}${grown ? `  (${grown.deltaBytes > 0 ? '+' : '-'}${formatBytes(Math.abs(grown.deltaBytes))})` : ''}`)
    }
    out.push('')
  }

  const planned = new Set(report.plan.ids)
  const plan = report.items.filter((i) => planned.has(i.id))
  if (plan.length) {
    out.push(`Plan: about ${formatBytes(report.plan.bytes)} can be freed safely, best value first (ranked by bytes per unit of risk)`)
    plan.slice(0, limit).forEach((i, n) => {
      out.push(`  ${String(n + 1).padStart(3)}. ${size(i)}  ${SAFETY_LABEL[i.safety].padEnd(12)}  ${i.title}`)
      if (why) out.push(`         ${i.why}`)
    })
    if (plan.length > limit) out.push(`       … and ${plan.length - limit} more (--all lists them)`)
    out.push('')
  } else {
    out.push('Nothing can be freed safely right now.', '')
  }

  const notEligible = report.items.filter((i) => !i.eligible && i.safety !== 'human')
  if (notEligible.length) {
    out.push('Kept, and why')
    for (const i of notEligible.slice(0, limit)) out.push(`  ${size(i)}  ${i.title}: ${i.why.replace(/^Kept: /, '')}${i.suggested && /needs root|Needs root/.test(i.why) ? `  [by hand: ${i.suggested}]` : ''}`)
    out.push('')
  }
  if (report.kept.length) {
    out.push('Build output kept because the project is in use')
    for (const k of report.kept.slice(0, limit)) out.push(`  ${k.root}: ${k.reason}${k.dirs > 1 ? ` (${k.dirs} dirs)` : ''}`)
    if (report.kept.length > limit) out.push(`  … and ${report.kept.length - limit} more`)
    out.push('')
  }

  const human = report.items.filter((i) => i.safety === 'human')
  if (human.length) {
    out.push('Needs a human (reported, never deleted)')
    for (const i of human.slice(0, limit)) {
      out.push(`  ${size(i)}  ${i.title}`)
      if (why) out.push(`         ${i.why}`)
      if (i.suggested) out.push(`         look: ${i.suggested}`)
    }
    out.push('')
  }

  for (const w of report.warnings) out.push(`! ${w}`)
  return out
}

export function formatApply(result: ApplyResult, titles: Map<string, string>): string[] {
  if (result.dryRun) {
    const total = result.wouldRemove.reduce((sum, i) => sum + Math.max(0, i.bytes), 0)
    if (result.stopped) return ['Enough space is free already; nothing to do.']
    if (!result.wouldRemove.length) return ['Nothing to remove.']
    return [
      `Dry run: would remove ${result.wouldRemove.length} item${result.wouldRemove.length === 1 ? '' : 's'}, about ${formatBytes(total)}. Nothing was deleted.`,
      ...result.wouldRemove.map((i) => `  ${formatBytes(i.bytes).padStart(9)}  ${i.title}`),
      'Run again with --apply to remove them.',
    ]
  }
  if (result.locked) return ['Another clean is already running on this target; nothing was done.']
  const lines = result.results.map((r) => `  ${r.status.padEnd(10)} ${`${r.measured ? '' : '*'}${formatBytes(r.freedBytes)}`.padStart(9)}  ${titles.get(r.id) ?? r.id}${r.status === 'ok' ? '' : `: ${r.message}`}`)
  return [
    `Freed about ${formatBytes(result.freedBytes)} on ${result.target}${result.results.some((r) => !r.measured) ? ' (measured as free space before and after each step; * = too small to measure, estimated)' : ' (measured as free space before and after each step)'}.`,
    ...lines,
    ...(result.stopped ? ['Stopped early: the free-space goal was reached.'] : []),
  ]
}
