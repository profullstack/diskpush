/**
 * Fleet Sync's pure helpers, kept out of the component so they are tested
 * without the app's module aliases.
 */

export type FailedDestination = { name: string; host: string; message: string; log: string[] }

/** The text a person pastes into an issue or a chat: what failed, where, and rsync's own words. */
export function errorReport(d: FailedDestination): string {
  return [`Fleet Sync to ${d.name}${d.host ? ` (${d.host})` : ''} failed: ${d.message}`, ...(d.log.length ? ['', ...d.log] : [])].join('\n')
}

/**
 * Where the source lands when the destination box is empty (or says the same
 * path): the same path on every host. rsync copies a folder named without a
 * trailing slash INTO its destination, so sending `~/a/ideas` to `~/a/ideas`
 * would make `~/a/ideas/ideas`. Sending it to the parent, `~/a/`, makes
 * `~/a/ideas`, and works for a single file too. A path the user typed that
 * differs from the source is theirs and goes through untouched.
 */
export function destinationFor(sourcePath: string, destPath: string): string {
  const source = sourcePath.trim()
  const dest = destPath.trim()
  if (dest && dest !== source) return dest
  if (source.endsWith('/')) return source
  const slash = source.lastIndexOf('/')
  if (slash === -1) return '.'
  return source.slice(0, slash + 1)
}
