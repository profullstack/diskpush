/**
 * rsync-style include/exclude patterns, for the S3 engine.
 *
 * The common subset, with rsync's meaning:
 *   - no `/` in the pattern: matches the last path component at any depth
 *   - a leading `/`: anchored at the transfer root
 *   - a `/` elsewhere: matched against the end of the path
 *   - a trailing `/`: matches directories only
 *   - `*` and `?` stop at `/`; `**` crosses it
 * Includes win over excludes, as an earlier `--include` does in rsync.
 */

function globToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else out += '[^/]*'
    } else if (char === '?') out += '[^/]'
    else if (char === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) out += '\\['
      else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else out += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return out
}

export type PathMatcher = (relPath: string, isDirectory: boolean) => boolean

export function compilePattern(pattern: string): PathMatcher {
  const dirOnly = pattern.endsWith('/')
  let body = dirOnly ? pattern.slice(0, -1) : pattern
  const anchored = body.startsWith('/')
  if (anchored) body = body.slice(1)
  const regex = body.includes('/') || anchored
    ? new RegExp(`${anchored ? '^' : '(?:^|/)'}${globToRegex(body)}$`)
    : new RegExp(`(?:^|/)${globToRegex(body)}$`)
  return (relPath, isDirectory) => (!dirOnly || isDirectory) && regex.test(relPath)
}

/** True when a path is excluded: it matches an exclude and no include. */
export function compileFilter(includes: readonly string[], excludes: readonly string[]): PathMatcher {
  const inc = includes.map(compilePattern)
  const exc = excludes.map(compilePattern)
  return (relPath, isDirectory) => !inc.some((m) => m(relPath, isDirectory)) && exc.some((m) => m(relPath, isDirectory))
}

/** rsync's size suffixes: `500`, `10K`, `1.5M`, `2G`, `1MB` (KB/MB/GB are powers of 1000, K/M/G of 1024). */
export function parseRsyncSize(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgtp]?)(i?b)?$/i.exec(value.trim())
  if (!m) throw new Error(`"${value}" is not a size.`)
  const powers: Record<string, number> = { '': 0, k: 1, m: 2, g: 3, t: 4, p: 5 }
  const base = m[3] && m[3].toLowerCase() === 'b' ? 1000 : 1024
  return Math.round(Number(m[1]) * base ** powers[m[2]!.toLowerCase()]!)
}
