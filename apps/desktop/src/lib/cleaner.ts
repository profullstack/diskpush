/** Pure helpers for the Cleaner tab, kept out of the component so they are tested on their own. */
import type { CleanerItem, CleanerReport } from './api'
import { formatBytes } from './format'

export const CLEANER_CATEGORIES = ['caches', 'docker', 'logs', 'build', 'partials'] as const

const LABELS: Record<string, string> = {
  caches: 'Caches',
  docker: 'Docker',
  logs: 'Logs',
  build: 'Build output',
  partials: 'Partial files',
}

export function categoryLabel(category: string): string {
  return LABELS[category] ?? category
}

/** The report's plan: what is ticked when a report arrives. Never a needs-a-human item. */
export function plannedItems(report: CleanerReport): CleanerItem[] {
  const planned = new Set(report.plan.ids)
  return report.items.filter((i) => planned.has(i.id) && i.eligible && i.safety !== 'human')
}

/** Bytes of the ticked items that can actually be removed. */
export function selectedBytes(items: readonly CleanerItem[], chosen: ReadonlySet<string>): number {
  return items.filter((i) => chosen.has(i.id) && i.eligible && i.safety !== 'human').reduce((sum, i) => sum + Math.max(0, i.bytes), 0)
}

export function sizeLabel(item: CleanerItem): string {
  if (item.bytes < 0) return '?'
  return `${item.upTo && item.bytes > 0 ? '≤ ' : ''}${formatBytes(item.bytes)}`
}
