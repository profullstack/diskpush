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
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond, 0)}/s` : '-'
}

export function formatDate(iso: string): string {
  if (!iso) return '-'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '-' : date.toISOString().slice(0, 16).replace('T', ' ')
}

export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

/** Purely lexical: the renderer never resolves a path against a real filesystem. */
export function parentPath(path: string): string {
  if (path === '/' || path === '') return path
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

export function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

/** rsync's most consequential punctuation mark. */
export function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`
}
