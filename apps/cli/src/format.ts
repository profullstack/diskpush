/** Output helpers. Everything here is presentation only. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value.toFixed(fractionDigits)} ${UNITS[unit]}`
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '-'
  return `${formatBytes(bytesPerSecond, 0)}/s`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/** Remaining time, derived rather than taken from rsync's own estimate. */
export function estimateRemaining(percent: number, elapsedSeconds: number): number | null {
  if (percent <= 0 || percent >= 100 || elapsedSeconds <= 0) return null
  return (elapsedSeconds / percent) * (100 - percent)
}

export function table(rows: readonly string[][], headers?: readonly string[]): string {
  const all = headers ? [headers as string[], ...rows] : [...rows]
  if (all.length === 0) return ''
  const widths: number[] = []
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  const render = (row: readonly string[]) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ')

  if (!headers) return all.map(render).join('\n')
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')
  return [render(headers), separator, ...rows.map(render)].join('\n')
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}
