import type { Connection } from '@diskpush/schemas'

/**
 * Choosing which servers a command runs on.
 *
 * The selector is the whole safety story for a fleet command: everything else
 * in this package assumes the set is already right. So it is deliberately
 * small and predictable, and it refuses rather than guesses.
 *
 *   all                every saved connection
 *   web-01             one connection, by name or id
 *   web-*              a glob over names
 *   tag:production     every connection carrying that tag
 *   host:10.0.0.*      a glob over hostnames
 *   !web-03            remove from the set
 *   !tag:canary        remove a whole tag from the set
 *
 * Terms are also accepted comma-separated inside one argument, so both
 * `--on web-01 --on web-02` and `--on web-01,web-02` mean the same thing.
 */

export class SelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionError'
  }
}

export type Selection = {
  matched: Connection[]
  /** Terms that matched nothing. A typo'd hostname is not a smaller fleet. */
  unmatched: string[]
}

/** Splits `--on a,b --on c` into `['a', 'b', 'c']`, dropping empties. */
export function parseSelector(terms: readonly string[]): string[] {
  return terms
    .flatMap((term) => term.split(','))
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

/**
 * Glob matching for `*` and `?` only.
 *
 * Not a full glob: connection names are not paths, and character classes buy
 * nothing here but a way to write a selector nobody can read at a glance.
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function matchesTerm(term: string, connection: Connection): boolean {
  if (term === 'all' || term === '*') return true

  if (term.startsWith('tag:')) {
    const tag = term.slice(4).toLowerCase()
    return connection.tags.some((candidate) => globMatch(tag, candidate.toLowerCase()))
  }

  if (term.startsWith('host:')) {
    return globMatch(term.slice(5), connection.host)
  }

  // An exact id match first: ids are opaque and should never be glob-matched
  // into a neighbour.
  if (connection.id === term) return true
  return globMatch(term, connection.name)
}

/**
 * Resolves a selector against the fleet.
 *
 * Include terms are unioned, then exclusions are subtracted, so
 * `tag:web !web-03` reads the way it looks. Order within the selector does
 * not matter, which means a selector cannot mean two different things
 * depending on how it was assembled.
 */
export function selectConnections(connections: readonly Connection[], terms: readonly string[]): Selection {
  const parsed = parseSelector(terms)
  if (parsed.length === 0) throw new SelectionError('No servers selected. Use --on with a name, tag:NAME, or all.')

  const includes = parsed.filter((term) => !term.startsWith('!'))
  const excludes = parsed.filter((term) => term.startsWith('!')).map((term) => term.slice(1))

  if (includes.length === 0) {
    throw new SelectionError('That selector only excludes servers. Add something to start from, such as `all`.')
  }
  for (const term of excludes) {
    if (term.length === 0) throw new SelectionError('`!` on its own is not a server. Write `!name` or `!tag:name`.')
  }

  const unmatched: string[] = []
  const matched = new Map<string, Connection>()

  for (const term of includes) {
    const hits = connections.filter((connection) => matchesTerm(term, connection))
    if (hits.length === 0) unmatched.push(term)
    for (const hit of hits) matched.set(hit.id, hit)
  }

  for (const term of excludes) {
    const hits = connections.filter((connection) => matchesTerm(term, connection))
    // An exclusion matching nothing is reported too. `!web-O3` (letter O) is
    // meant to protect a server and silently protects none.
    if (hits.length === 0) unmatched.push(`!${term}`)
    for (const hit of hits) matched.delete(hit.id)
  }

  return {
    matched: [...matched.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unmatched,
  }
}

/** Every tag in use, for a picker. Sorted, deduped, case preserved from first use. */
export function fleetTags(connections: readonly Connection[]): string[] {
  const seen = new Map<string, string>()
  for (const connection of connections) {
    for (const tag of connection.tags) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}
