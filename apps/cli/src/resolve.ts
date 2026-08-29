import { execFileSync } from 'node:child_process'
import {
  EXCLUDE_PRESETS,
  parseEndpoint,
  parseRsyncCapabilities,
  presetOptions,
  unknownCapabilities,
  type RsyncCapabilities,
} from '@diskpush/rsync-core'
import type { DiskPushStore } from '@diskpush/database'
import {
  PresetNameSchema,
  defaultRsyncOptions,
  type Connection,
  type Endpoint,
  type RsyncOptions,
  type SshEndpoint,
} from '@diskpush/schemas'
import { ArgvError, flagValue, flagValues, hasFlag, numberFlag, type ParsedArgv } from './parse-argv.js'

/**
 * An endpoint plus whatever the saved connection contributes to it.
 *
 * A bare `prod:/srv/app/` resolves against the connection manager when `prod`
 * is a saved name, and falls through to a plain SSH host (or ~/.ssh/config
 * alias) when it is not. Both are legitimate; only the first can supply a
 * port, key, jump host or remote rsync path.
 */
export type ResolvedEndpoint = {
  endpoint: Endpoint
  connection: Connection | null
}

export async function resolveEndpoint(store: DiskPushStore, input: string): Promise<ResolvedEndpoint> {
  const endpoint = parseEndpoint(input)
  if (endpoint.type === 'local') return { endpoint, connection: null }

  const connection = await store.findConnection(endpoint.host)
  if (!connection) return { endpoint, connection: null }

  const resolved: SshEndpoint = {
    ...endpoint,
    host: connection.host,
    user: endpoint.user ?? connection.username,
    port: endpoint.port ?? connection.port,
    connectionId: connection.id,
  }
  return { endpoint: resolved, connection }
}

/** Where a saved connection's cached capability report lives. */
export function capabilityCacheKey(connectionId: string): string {
  return `capabilities:${connectionId}`
}

export function detectLocalCapabilities(): RsyncCapabilities {
  try {
    return parseRsyncCapabilities(execFileSync('rsync', ['--version'], { encoding: 'utf8' }))
  } catch {
    return unknownCapabilities()
  }
}

export function localRsyncMissing(): boolean {
  return detectLocalCapabilities().version === null
}

/**
 * Builds the effective options from the precedence the PRD specifies:
 *
 *   safe defaults -> preset -> structured CLI flags -> raw args after `--`
 */
export function optionsFromFlags(parsed: ParsedArgv, base?: RsyncOptions): RsyncOptions {
  const presetName = flagValue(parsed, '--preset')
  let options = base ?? (presetName ? presetOptions(PresetNameSchema.parse(presetName)) : defaultRsyncOptions())

  const excludes = [...options.excludes, ...flagValues(parsed, '--exclude')]
  for (const name of flagValues(parsed, '--exclude-preset')) {
    const preset = EXCLUDE_PRESETS[name]
    if (!preset) {
      throw new ArgvError(
        `Unknown exclude preset ${JSON.stringify(name)}. Available: ${Object.keys(EXCLUDE_PRESETS).join(', ')}.`,
      )
    }
    excludes.push(...preset)
  }

  options = {
    ...options,
    excludes,
    includes: [...options.includes, ...flagValues(parsed, '--include')],
    rawArgs: [...parsed.rawArgs],
  }

  if (hasFlag(parsed, '--checksum') || hasFlag(parsed, '--verify')) options.checksum = true
  if (hasFlag(parsed, '--no-archive')) options.archive = false
  if (hasFlag(parsed, '--stats')) options.stats = true
  if (hasFlag(parsed, '--dry-run')) options.dryRun = true
  if (hasFlag(parsed, '--update')) options.update = true
  if (hasFlag(parsed, '--ignore-existing')) options.ignoreExisting = true
  if (hasFlag(parsed, '--existing')) options.existingOnly = true
  if (hasFlag(parsed, '--hard-links')) options.hardLinks = true
  if (hasFlag(parsed, '--acls')) options.acls = true
  if (hasFlag(parsed, '--xattrs')) options.xattrs = true
  if (hasFlag(parsed, '--numeric-ids')) options.numericIds = true
  if (hasFlag(parsed, '--sparse')) options.sparse = true
  if (hasFlag(parsed, '--prune-empty-dirs')) options.pruneEmptyDirs = true
  if (hasFlag(parsed, '--relative')) options.relative = true
  if (hasFlag(parsed, '--inplace')) options.inplace = true
  if (hasFlag(parsed, '--append-verify')) options.appendVerify = true
  if (hasFlag(parsed, '--mkpath')) options.mkpath = true
  if (hasFlag(parsed, '--itemize-all')) options.itemizeAll = true

  if (hasFlag(parsed, '--compress')) {
    const choice = flagValue(parsed, '--compress')
    options.compression = choice === '' || choice === undefined ? 'zstd' : (choice as RsyncOptions['compression'])
  }
  if (hasFlag(parsed, '--no-compress')) options.compression = 'off'

  const bwlimit = flagValue(parsed, '--bwlimit')
  if (bwlimit) options.bwlimit = bwlimit
  const maxSize = flagValue(parsed, '--max-size')
  if (maxSize) options.maxSize = maxSize
  const minSize = flagValue(parsed, '--min-size')
  if (minSize) options.minSize = minSize
  const partialDir = flagValue(parsed, '--partial-dir')
  if (partialDir) options.partialDir = partialDir
  const excludeFrom = flagValue(parsed, '--exclude-from')
  if (excludeFrom) options.excludeFrom = excludeFrom
  const includeFrom = flagValue(parsed, '--include-from')
  if (includeFrom) options.includeFrom = includeFrom
  const filesFrom = flagValue(parsed, '--files-from')
  if (filesFrom) options.filesFrom = filesFrom
  const rsyncPath = flagValue(parsed, '--rsync-path')
  if (rsyncPath) options.rsyncPath = rsyncPath

  const timeout = numberFlag(parsed, '--timeout')
  if (timeout !== undefined) options.timeoutSeconds = timeout

  return options
}
