/**
 * POSIX single-quote quoting.
 *
 * Local rsync is always spawned with `shell: false`, so nothing here applies
 * to it. This exists for exactly one case: `ssh host <command>` always runs
 * the command through the remote user's login shell, joining argv with
 * spaces. Server-to-server orchestration therefore has to quote its own
 * tokens, and this is the only place in DiskPush allowed to build one.
 */
export function shellQuote(token: string): string {
  if (token === '') return "''"
  // Unreserved characters need no quoting and keep the visible command readable.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token
  return `'${token.replaceAll("'", `'\\''`)}'`
}

export function shellJoin(tokens: readonly string[]): string {
  return tokens.map(shellQuote).join(' ')
}
