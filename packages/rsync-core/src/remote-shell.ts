import type { Connection } from '@diskpush/schemas'

export class RemoteShellError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteShellError'
  }
}

export type RemoteShellOptions = {
  port?: number | null
  keyPath?: string | null
  jumpHost?: string | null
  forwardAgent?: boolean
  connectTimeoutSeconds?: number | null
  knownHostsPath?: string | null
  /** Never prompt: a hung password prompt inside rsync is unrecoverable. */
  batchMode?: boolean
  /** Extra `-o Key=Value` pairs. Values may not contain whitespace. */
  extraOptions?: readonly string[]
}

/**
 * Builds the argv for the SSH transport rsync should use.
 *
 * Returned as tokens, not a string, because the caller decides how to render
 * them, and because a token list is checkable.
 */
export function buildRemoteShellTokens(options: RemoteShellOptions): string[] {
  const tokens: string[] = ['ssh']

  if (options.port != null && options.port !== 22) tokens.push('-p', String(options.port))
  if (options.keyPath) tokens.push('-i', options.keyPath)
  if (options.jumpHost) tokens.push('-J', options.jumpHost)
  if (options.forwardAgent) tokens.push('-A')
  if (options.connectTimeoutSeconds != null) {
    tokens.push('-o', `ConnectTimeout=${options.connectTimeoutSeconds}`)
  }
  if (options.knownHostsPath) tokens.push('-o', `UserKnownHostsFile=${options.knownHostsPath}`)
  if (options.batchMode !== false) tokens.push('-o', 'BatchMode=yes')

  // Host keys are always verified. There is no DiskPush setting that turns
  // this off, because "accept-new" is the weakest position we are willing to
  // take and disabling it globally is how people get silently MITM'd.
  tokens.push('-o', 'StrictHostKeyChecking=accept-new')

  for (const option of options.extraOptions ?? []) tokens.push('-o', option)
  return tokens
}

/**
 * rsync's `-e` takes one string and splits it on whitespace itself, with no
 * quoting of any kind. A key path containing a space is therefore
 * unrepresentable, and we say so rather than producing a command that
 * silently targets the wrong file.
 */
export function renderRemoteShell(tokens: readonly string[]): string {
  for (const token of tokens) {
    if (/\s/.test(token)) {
      throw new RemoteShellError(
        `The SSH transport option ${JSON.stringify(token)} contains whitespace. ` +
          'rsync splits its remote-shell command on spaces and cannot quote it. ' +
          'Move this host into ~/.ssh/config and reference it by alias, or use a path without spaces.',
      )
    }
  }
  return tokens.join(' ')
}

export function remoteShellForConnection(connection: Connection, overrides: RemoteShellOptions = {}): string[] {
  return buildRemoteShellTokens({
    port: connection.port,
    keyPath: connection.authType === 'key' || connection.authType === 'key-passphrase' ? connection.keyPath : null,
    jumpHost: connection.jumpHost,
    forwardAgent: connection.forwardAgent,
    connectTimeoutSeconds: connection.connectTimeoutSeconds,
    ...overrides,
  })
}
