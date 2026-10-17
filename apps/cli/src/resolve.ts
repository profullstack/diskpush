import { execFileSync } from 'node:child_process'
import { sshConfigConnections } from '@diskpush/ssh-core'
import {
  EXCLUDE_PRESETS,
  parseEndpoint,
  parseRsyncCapabilities,
  presetOptions,
  unknownCapabilities,
  type RsyncCapabilities,
} from '@diskpush/rsync-core'
import type { DiskPushStore } from '@diskpush/database'
import { S3_SECRET_NAME, adhocS3Settings, s3ClientFor, type S3Client } from '@diskpush/s3-core'
import {
  PresetNameSchema,
  defaultRsyncOptions,
  isS3Connection,
  type Connection,
  type Endpoint,
  type RsyncOptions,
  type S3Endpoint,
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

/**
 * Builds an unsaved connection from a `~/.ssh/config` entry.
 *
 * Transfers get ssh_config for free, because rsync shells out to ssh and ssh
 * reads the file. Browsing does not: SFTP goes through ssh2, which has never
 * read ssh_config. Without this, `diskpush prod:/srv/` would transfer happily
 * while `diskpush ls prod:/srv/` claimed the host did not exist.
 */
/**
 * One `~/.ssh/config` entry as an unsaved connection.
 *
 * Transfers get ssh_config for free, because rsync shells out to ssh and ssh
 * reads the file. Browsing does not: SFTP goes through ssh2, which has never
 * read it. Without this, `diskpush prod:/srv/` would transfer happily while
 * `diskpush ls prod:/srv/` claimed the host did not exist.
 */
/** Every host in ~/.ssh/config, as unsaved connections. */
export function sshConfigHosts(env: NodeJS.ProcessEnv = process.env): Connection[] {
  return sshConfigConnections(env)
}

export function sshConfigConnection(alias: string, env: NodeJS.ProcessEnv = process.env): Connection | null {
  return sshConfigConnections(env).find((connection) => connection.name === alias) ?? null
}

export async function resolveEndpoint(store: DiskPushStore, input: string): Promise<ResolvedEndpoint> {
  const endpoint = parseEndpoint(input)
  if (endpoint.type === 'local') return { endpoint, connection: null }

  if (endpoint.type === 's3') {
    // `s3://bucket/key`: a saved connection for that bucket supplies the
    // endpoint and credentials; without one it is ad hoc, on AWS_* variables.
    const saved = (await store.listConnections()).find((c) => isS3Connection(c) && c.s3.bucket === endpoint.bucket) ?? null
    if (!saved) return { endpoint, connection: null }
    return { endpoint: { ...endpoint, connectionId: saved.id, name: saved.name }, connection: saved }
  }

  const saved = await store.findConnection(endpoint.host)
  if (isS3Connection(saved)) {
    // `backups:/db/` where `backups` is a saved bucket.
    const path = endpoint.path === '.' ? (saved.defaultRemotePath ?? '/') : endpoint.path
    const resolved: S3Endpoint = { type: 's3', connectionId: saved.id, name: saved.name, bucket: saved.s3.bucket, path: path.startsWith('/') ? path : `/${path}` }
    return { endpoint: resolved, connection: saved }
  }
  // A saved connection wins; otherwise fall back to ~/.ssh/config, which is
  // where most people already keep their hosts.
  const connection = saved ?? sshConfigConnection(endpoint.host)
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

/**
 * The S3 client for a resolved bucket endpoint: the saved connection's
 * settings and stored secret, or, ad hoc, AWS_ENDPOINT_URL / AWS_REGION and
 * the AWS_* keys.
 */
export async function s3ClientForEndpoint(
  store: DiskPushStore,
  resolved: ResolvedEndpoint,
  env: NodeJS.ProcessEnv = process.env,
): Promise<S3Client> {
  if (resolved.endpoint.type !== 's3') throw new Error('Not an S3 endpoint.')
  if (isS3Connection(resolved.connection)) {
    const secret = await store.getConnectionSecret(resolved.connection.id, S3_SECRET_NAME)
    return s3ClientFor(resolved.connection.s3, secret, env, resolved.connection.name)
  }
  return s3ClientFor(adhocS3Settings(resolved.endpoint.bucket, env), null, env, `s3://${resolved.endpoint.bucket}`)
}

/**
 * A stored endpoint back as the string a user would type, so a job or profile
 * re-resolves through the same path: `name:/path` for a saved connection
 * (SSH or bucket), `s3://bucket/path` for an ad-hoc bucket.
 */
export function renderStoredEndpoint(endpoint: Endpoint): string {
  if (endpoint.type === 'local') return endpoint.path
  if (endpoint.type === 's3') return endpoint.connectionId ? `${endpoint.name}:${endpoint.path}` : `s3://${endpoint.bucket}${endpoint.path.startsWith('/') ? '' : '/'}${endpoint.path}`
  const prefix = endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host
  return `${prefix}:${endpoint.path}`
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
  if (hasFlag(parsed, '--progress')) options.perFileProgress = true

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
