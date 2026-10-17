/**
 * Shell-style path completion for a path typed into a box: `~/pro` lists `~/`
 * and offers `projects/`, `/ho` offers `/home/`. Pure, so it is tested without
 * a listing behind it; the component supplies the listing.
 */

export type Side = 'local' | 'remote'

export type CompletionEntry = { name: string; type: 'file' | 'directory' | 'symlink' | 'other'; targetType?: string }

export type Suggestion = { value: string; label: string; isDirectory: boolean }

/** The directory the user is typing in (as typed) and the partial name after it. */
export function splitForCompletion(input: string): { dir: string; prefix: string } {
  if (input === '~') return { dir: '~/', prefix: '' }
  const slash = input.lastIndexOf('/')
  if (slash === -1) return { dir: '', prefix: input }
  return { dir: input.slice(0, slash + 1), prefix: input.slice(slash + 1) }
}

/**
 * The path to ask the listing for. Local listings expand `~` themselves. Over
 * SFTP there is no `~`, but a relative path starts in the home directory, so
 * `~/x` is just `x` and `~` (or nothing typed) is `.`.
 */
export function listingPath(dir: string, side: Side): string {
  if (side === 'local') return dir === '' ? '~' : dir
  if (dir === '' || dir === '~/' || dir === '~') return '.'
  if (dir.startsWith('~/')) return dir.slice(2)
  return dir
}

const isDir = (e: CompletionEntry) => e.type === 'directory' || (e.type === 'symlink' && e.targetType === 'directory')

/**
 * The matches for what was typed, directories first, each as the full value the
 * box should hold. Dotfiles only when the prefix starts with a dot, as in a shell.
 */
export function suggestions(input: string, entries: readonly CompletionEntry[], limit = 50): Suggestion[] {
  const { dir, prefix } = splitForCompletion(input)
  const showHidden = prefix.startsWith('.')
  const exact = entries.filter((e) => e.name.startsWith(prefix))
  // Case-insensitive only when nothing matches exactly, so `Do` still finds `Documents` but `do` prefers `downloads`.
  const pool = exact.length ? exact : entries.filter((e) => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
  return pool
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => ({ value: `${dir}${e.name}${isDir(e) ? '/' : ''}`, label: `${e.name}${isDir(e) ? '/' : ''}`, isDirectory: isDir(e) }))
}

/** What Tab does: the longest prefix every match shares, or the one match. Null when it would not change the input. */
export function tabComplete(input: string, matches: readonly Suggestion[]): string | null {
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]!.value === input ? null : matches[0]!.value
  let common = matches[0]!.value
  for (const m of matches) {
    let i = 0
    while (i < common.length && i < m.value.length && common[i] === m.value[i]) i++
    common = common.slice(0, i)
  }
  return common.length > input.length ? common : null
}
