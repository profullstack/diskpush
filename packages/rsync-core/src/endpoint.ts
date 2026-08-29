import type { Endpoint, SshEndpoint } from '@diskpush/schemas'

export class EndpointParseError extends Error {
  constructor(message: string, readonly input: string) {
    super(message)
    this.name = 'EndpointParseError'
  }
}

const USER_HOST_PATH = /^([^@:/\s]+)@([^@:/\s]+):(.*)$/
const HOST_PATH = /^([A-Za-z0-9_][A-Za-z0-9._-]*):(.*)$/
/**
 * `C:\Users` is a drive; `a:/srv` is a one-letter hostname. Both match the
 * same shape, so the backslash form is always local, while the forward-slash
 * form is only a drive when we are actually running on Windows.
 */
const WINDOWS_DRIVE_BACKSLASH = /^[A-Za-z]:\\/
const WINDOWS_DRIVE_ANY = /^[A-Za-z]:[\\/]/

/**
 * Turns a CLI-style endpoint string into a structured endpoint.
 *
 * `host:path` is remote; anything that starts with a path separator, a dot,
 * or a tilde is local. The result is a value object precisely so that no
 * caller is tempted to rebuild it by string concatenation later.
 */
export function parseEndpoint(input: string, platform: NodeJS.Platform = process.platform): Endpoint {
  const value = input.trim()
  if (value === '') throw new EndpointParseError('Endpoint is empty', input)

  if (value.startsWith('rsync://')) {
    throw new EndpointParseError('rsync:// daemon endpoints are not supported; use an SSH endpoint', input)
  }

  const drivePattern = platform === 'win32' ? WINDOWS_DRIVE_ANY : WINDOWS_DRIVE_BACKSLASH
  if (drivePattern.test(value)) return { type: 'local', path: value }

  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~') || value === '.' || value === '..') {
    return { type: 'local', path: value }
  }

  const userHost = USER_HOST_PATH.exec(value)
  if (userHost) {
    return sshEndpoint({ user: userHost[1]!, host: userHost[2]!, path: userHost[3]! })
  }

  const hostOnly = HOST_PATH.exec(value)
  if (hostOnly) {
    return sshEndpoint({ host: hostOnly[1]!, path: hostOnly[2]! })
  }

  return { type: 'local', path: value }
}

function sshEndpoint(parts: { user?: string; host: string; path: string }): SshEndpoint {
  // `host:` with no path means the remote user's home directory.
  const path = parts.path === '' ? '.' : parts.path
  const endpoint: SshEndpoint = { type: 'ssh', host: parts.host, path }
  if (parts.user !== undefined) endpoint.user = parts.user
  return endpoint
}

/**
 * Renders an endpoint as the single argv token rsync expects.
 *
 * The port is deliberately absent: it belongs in the remote-shell command,
 * because `host:port:/path` is not a thing rsync understands.
 */
export function renderEndpoint(endpoint: Endpoint): string {
  if (endpoint.type === 'local') return endpoint.path
  const prefix = endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host
  return `${prefix}:${endpoint.path}`
}

/**
 * rsync's most consequential piece of punctuation: `src/` copies the contents
 * of src, `src` copies the directory itself into the destination.
 */
export function withTrailingSlash(endpoint: Endpoint): Endpoint {
  if (endpoint.path.endsWith('/')) return endpoint
  return { ...endpoint, path: `${endpoint.path}/` }
}

export function hasTrailingSlash(endpoint: Endpoint): boolean {
  return endpoint.path.endsWith('/')
}

/** True when the two endpoints name the same host (so no network hop is needed). */
export function sameHost(a: Endpoint, b: Endpoint): boolean {
  if (a.type === 'local' && b.type === 'local') return true
  if (a.type !== 'ssh' || b.type !== 'ssh') return false
  return a.host === b.host && (a.user ?? '') === (b.user ?? '') && (a.port ?? 22) === (b.port ?? 22)
}
