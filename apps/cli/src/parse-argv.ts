/**
 * The CLI's own argument parser.
 *
 * Hand-written for one reason: the `--` boundary has to be exact. Everything
 * before it belongs to DiskPush; everything after is handed to rsync as
 * verbatim tokens, in order, with no reinterpretation of any kind. Most
 * general-purpose parsers either swallow the separator or normalise what
 * follows it, and both are wrong here.
 */

export type ParsedArgv = {
  command: string | null
  positionals: string[]
  flags: Map<string, string[]>
  rawArgs: string[]
  /** True when a standalone `--` was present, even with nothing after it. */
  hasSeparator: boolean
}

/**
 * DiskPush flags that consume the following token as their value.
 *
 * A flag whose value is optional is deliberately absent: `--compress` must
 * stay a boolean so that `diskpush sync --compress ./a/ ./b/` does not eat an
 * endpoint. Optional values use the `--flag=value` form only.
 */
export const VALUE_FLAGS = new Set([
  '--profile',
  '--preset',
  '--exclude',
  '--exclude-preset',
  '--include',
  '--exclude-from',
  '--include-from',
  '--files-from',
  '--bwlimit',
  '--max-size',
  '--min-size',
  '--partial-dir',
  '--connection-timeout',
  '--timeout',
  '--rsync-path',
  '--limit',
  '--state',
  // connections add
  '--port',
  '--identity',
  '--key',
  '--path',
  '--jump',
])

/** Single-letter aliases. */
const ALIASES: Record<string, string> = {
  '-n': '--dry-run',
  '-q': '--quiet',
  '-y': '--yes',
  '-h': '--help',
  '-V': '--version',
  '-p': '--profile',
  '-e': '--exclude',
}

const KNOWN_COMMANDS = new Set([
  'sync',
  'push',
  'pull',
  'publish',
  'deploy',
  'backup',
  'mirror',
  'rsync',
  'ls',
  'connections',
  'profiles',
  'profile',
  'jobs',
  'job',
  'retry',
  'update',
  'upgrade',
  'uninstall',
  'remove',
  'doctor',
  'desktop',
  'tui',
  'help',
  'version',
])

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const separatorIndex = argv.indexOf('--')
  const hasSeparator = separatorIndex !== -1
  const own = hasSeparator ? argv.slice(0, separatorIndex) : [...argv]
  const rawArgs = hasSeparator ? argv.slice(separatorIndex + 1) : []

  const flags = new Map<string, string[]>()
  const positionals: string[] = []

  for (let i = 0; i < own.length; i += 1) {
    const token = own[i]!
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    const normalized = ALIASES[token] ?? token

    // `--flag=value` keeps the value attached, which matters for globs
    // containing spaces: `--exclude='my dir/'`.
    const equals = normalized.indexOf('=')
    if (equals !== -1) {
      addFlag(flags, normalized.slice(0, equals), normalized.slice(equals + 1))
      continue
    }

    if (VALUE_FLAGS.has(normalized)) {
      const value = own[i + 1]
      if (value === undefined) {
        throw new ArgvError(`${normalized} needs a value.`)
      }
      addFlag(flags, normalized, value)
      i += 1
      continue
    }

    addFlag(flags, normalized, '')
  }

  let command: string | null = null
  if (positionals.length > 0 && KNOWN_COMMANDS.has(positionals[0]!)) {
    command = positionals.shift()!
  }

  return { command, positionals, flags, rawArgs, hasSeparator }
}

function addFlag(flags: Map<string, string[]>, name: string, value: string) {
  const existing = flags.get(name)
  if (existing) existing.push(value)
  else flags.set(name, [value])
}

export class ArgvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgvError'
  }
}

export function hasFlag(parsed: ParsedArgv, name: string): boolean {
  return parsed.flags.has(name)
}

export function flagValue(parsed: ParsedArgv, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1)
}

export function flagValues(parsed: ParsedArgv, name: string): string[] {
  return (parsed.flags.get(name) ?? []).filter((v) => v !== '')
}

export function numberFlag(parsed: ParsedArgv, name: string): number | undefined {
  const value = flagValue(parsed, name)
  if (value === undefined || value === '') return undefined
  const parsedNumber = Number(value)
  if (!Number.isFinite(parsedNumber)) throw new ArgvError(`${name} must be a number, got ${JSON.stringify(value)}.`)
  return parsedNumber
}

export function isKnownCommand(name: string): boolean {
  return KNOWN_COMMANDS.has(name)
}

/**
 * Does this positional look like an endpoint at all?
 *
 * The bare `diskpush SOURCE DESTINATION` form is convenient but it will
 * happily accept anything, so a mistyped subcommand (`diskpush conections
 * list`) becomes a request to sync a file called `conections` into one called
 * `list`. Requiring endpoint-shaped arguments turns that into an error
 * instead.
 */
export function looksLikeEndpoint(value: string, exists: (path: string) => boolean = () => false): boolean {
  if (value.includes('/') || value.includes(':') || value.includes('\\')) return true
  if (value === '.' || value === '..' || value.startsWith('~')) return true
  // A bare name is only an endpoint if something by that name is really there.
  return exists(value)
}
