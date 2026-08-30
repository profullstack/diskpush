import { existsSync, readFileSync } from 'node:fs'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { Connection } from '@diskpush/schemas'
import { keyTypeOf, sha256Fingerprint } from './fingerprint.js'
import { expandTilde, findAgentSocket, findDefaultIdentity } from './identity.js'
import { appendKnownHost, readKnownHosts, verifyHostKey, type HostKeyVerdict } from './known-hosts.js'

export class SshError extends Error {
  constructor(message: string, readonly kind: SshErrorKind = 'connect') {
    super(message)
    this.name = 'SshError'
  }
}

export type SshErrorKind = 'connect' | 'auth' | 'host-key' | 'exec' | 'sftp'

export type HostKeyPrompt = (details: {
  host: string
  port: number
  keyType: string
  fingerprint: string
  verdict: HostKeyVerdict
}) => Promise<boolean>

export type SessionOptions = {
  knownHostsPath: string
  /**
   * Asked only when a host is genuinely new. A *changed* key is never
   * prompted away here; it fails, and the user has to deal with it
   * deliberately.
   */
  onUnknownHostKey?: HostKeyPrompt
  agentSocket?: string | undefined
  passphrase?: string | undefined
  password?: string | undefined
}

export type ExecResult = { stdout: string; stderr: string; code: number }

/**
 * One SSH connection, reused for capability checks, SFTP browsing and remote
 * command execution.
 */
export class SshSession {
  private constructor(
    private readonly client: Client,
    readonly connection: Pick<Connection, 'host' | 'port' | 'username'>,
  ) {}

  static async connect(connection: Connection, options: SessionOptions): Promise<SshSession> {
    const client = new Client()
    const knownHosts = readKnownHosts(options.knownHostsPath)

    const config: ConnectConfig = {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      readyTimeout: connection.connectTimeoutSeconds * 1000,
      keepaliveInterval: connection.keepaliveSeconds ? connection.keepaliveSeconds * 1000 : 0,
    }

    if (connection.authType === 'agent') {
      // Both halves, the way ssh(1) does it: an agent if one can be found, and
      // the default identity files regardless. Requiring SSH_AUTH_SOCK to be
      // exported meant every agent host failed in the desktop app, which is
      // launched from a session that exports far less than a login shell.
      const agent = options.agentSocket ?? findAgentSocket(existsSync)
      if (agent) config.agent = agent

      const identity = findDefaultIdentity(existsSync)
      if (identity) {
        config.privateKey = readFileSync(identity)
        if (options.passphrase) config.passphrase = options.passphrase
      }

      if (!agent && !identity) {
        throw new SshError(
          'No SSH agent and no default key. Looked for an agent socket, then for ' +
            '~/.ssh/id_ed25519, id_ecdsa, id_rsa and id_dsa. Set a key file on this connection, ' +
            'or start an agent and add one.',
          'auth',
        )
      }
    } else if (connection.authType === 'key' || connection.authType === 'key-passphrase') {
      if (!connection.keyPath) throw new SshError('This connection is set to key authentication but has no key path.', 'auth')
      // `~` is expanded here rather than trusted to have been expanded by
      // whoever stored the path: it can come from ssh_config, from an import,
      // or from someone typing it into the New server dialog, and only one of
      // those three used to expand it.
      config.privateKey = readFileSync(expandTilde(connection.keyPath))
      if (options.passphrase) config.passphrase = options.passphrase
    } else if (connection.authType === 'password') {
      if (!options.password) throw new SshError('This connection needs a password, which was not supplied.', 'auth')
      config.password = options.password
    }

    let hostKeyFailure: string | null = null

    const verified = new Promise<void>((resolve, reject) => {
      config.hostVerifier = (keyBlob: Buffer, callback: (ok: boolean) => void) => {
        const keyType = keyTypeOf(keyBlob)
        const keyBase64 = keyBlob.toString('base64')
        const verdict = verifyHostKey(knownHosts, connection.host, connection.port, keyType, keyBase64)

        if (verdict.status === 'trusted') {
          callback(true)
          return
        }
        if (verdict.status === 'changed') {
          hostKeyFailure =
            `The SSH host key for ${connection.host} has changed.\n` +
            `Connection blocked for safety.\n` +
            `Offered: ${sha256Fingerprint(keyBlob)}\n` +
            'If this change was expected, remove the old entry from known_hosts and reconnect.'
          callback(false)
          return
        }
        if (verdict.status === 'revoked') {
          hostKeyFailure = `The SSH host key for ${connection.host} is marked revoked in known_hosts.`
          callback(false)
          return
        }

        if (!options.onUnknownHostKey) {
          hostKeyFailure =
            `${connection.host} is not in known_hosts and DiskPush was not given a way to ask about it.\n` +
            `Fingerprint: ${sha256Fingerprint(keyBlob)}`
          callback(false)
          return
        }

        void options
          .onUnknownHostKey({
            host: connection.host,
            port: connection.port,
            keyType,
            fingerprint: sha256Fingerprint(keyBlob),
            verdict,
          })
          .then((accepted) => {
            if (accepted) {
              appendKnownHost(options.knownHostsPath, connection.host, connection.port, keyType, keyBase64)
            } else {
              hostKeyFailure = 'The host key was not accepted.'
            }
            callback(accepted)
          })
          .catch((error: Error) => {
            hostKeyFailure = error.message
            callback(false)
          })
      }

      client.on('ready', () => resolve())
      client.on('error', (error: Error & { level?: string }) => {
        if (hostKeyFailure) {
          reject(new SshError(hostKeyFailure, 'host-key'))
          return
        }
        if (error.level === 'client-authentication') {
          reject(new SshError(`SSH authentication was rejected by ${connection.host}.`, 'auth'))
          return
        }
        reject(new SshError(error.message, 'connect'))
      })
      client.connect(config)
    })

    await verified
    return new SshSession(client, connection)
  }

  exec(command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(new SshError(error.message, 'exec'))
          return
        }
        let stdout = ''
        let stderr = ''
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        stream.on('close', (code: number | null) => resolve({ stdout, stderr, code: code ?? -1 }))
      })
    })
  }

  sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error) reject(new SshError(error.message, 'sftp'))
        else resolve(sftp)
      })
    })
  }

  close(): void {
    this.client.end()
  }
}
