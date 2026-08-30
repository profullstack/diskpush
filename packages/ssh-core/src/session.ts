import { existsSync, readFileSync } from 'node:fs'
import { Client, type AnyAuthMethod, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { Connection } from '@diskpush/schemas'
import { keyTypeOf, sha256Fingerprint } from './fingerprint.js'
import { expandTilde, findAgentSocket, findDefaultIdentities } from './identity.js'
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

export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  /** Set by `execStream` when it gave up on its own deadline. */
  timedOut?: boolean
}

export type ExecStreamOptions = {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  /** Written to the remote process and then closed. Used to feed `sudo -S` a password. */
  stdin?: string
  /** Kills the channel after this long. Omitted or 0 means no deadline. */
  timeoutSeconds?: number
  /**
   * Allocate a pty. Off by default: a pty merges stderr into stdout and makes
   * every `sudo` prompt for a password interactively, which is exactly what a
   * non-interactive fleet run must not do.
   */
  pty?: boolean
}

export type ExecHandle = {
  finished: Promise<ExecResult>
  /** SIGINT, then close the channel. Safe to call after it has already finished. */
  cancel: () => void
}

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
      // Every credential, offered in turn, the way ssh(1) does it: the agent
      // first if one can be found, then each default identity that exists.
      //
      // ssh2's `privateKey` holds exactly one key, so offering only the first
      // one meant a host that accepts id_rsa but not id_ed25519 rejected us
      // outright — while `ssh` to that same host from a terminal succeeded,
      // because it tries them all. An authHandler array is how ssh2 expresses
      // "try these, in this order".
      const agent = options.agentSocket ?? findAgentSocket(existsSync)
      const identities = findDefaultIdentities(existsSync)

      if (!agent && identities.length === 0) {
        throw new SshError(
          'No SSH agent and no default key. Looked for an agent socket, then for ' +
            '~/.ssh/id_ed25519, id_ecdsa, id_rsa and id_dsa. Set a key file on this connection, ' +
            'or start an agent and add one.',
          'auth',
        )
      }

      const methods: AnyAuthMethod[] = []
      if (agent) methods.push({ type: 'agent', username: connection.username, agent })
      for (const identity of identities) {
        methods.push({
          type: 'publickey',
          username: connection.username,
          key: readFileSync(identity),
          ...(options.passphrase ? { passphrase: options.passphrase } : {}),
        })
      }
      config.authHandler = methods
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

  /**
   * `exec`, but the output arrives while it is still happening.
   *
   * A package upgrade across a fleet runs for minutes per host and the whole
   * value of watching it is seeing which line it is on. `exec` above buffers
   * to completion, which is right for a capability probe and useless here.
   *
   * Output is split on newlines, so a caller gets whole lines rather than
   * whatever fell out of one TCP read. A trailing fragment with no newline is
   * still delivered, at close.
   */
  execStream(command: string, options: ExecStreamOptions = {}): ExecHandle {
    let cancel: () => void = () => {}
    let settled = false

    const finished = new Promise<ExecResult>((resolve, reject) => {
      this.client.exec(command, { pty: options.pty ?? false }, (error, stream) => {
        if (error) {
          reject(new SshError(error.message, 'exec'))
          return
        }

        let stdout = ''
        let stderr = ''
        // Held back until a newline arrives, so a line split across two reads
        // is emitted once rather than as two half-lines.
        let outRest = ''
        let errRest = ''
        let timer: NodeJS.Timeout | null = null

        const settle = (result: ExecResult) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve(result)
        }

        const drain = (rest: string, chunk: Buffer, emit: (line: string) => void): string => {
          const text = rest + chunk.toString('utf8')
          const lines = text.split('\n')
          const tail = lines.pop() ?? ''
          for (const line of lines) emit(line.replace(/\r$/, ''))
          return tail
        }

        cancel = () => {
          if (settled) return
          // The signal first, then a close: a shell that ignores SIGINT still
          // loses its channel rather than leaving the run hanging on it.
          try {
            stream.signal('INT')
          } catch {
            // ssh2 throws when the channel is already gone, which is fine.
          }
          stream.close()
        }

        if (options.timeoutSeconds && options.timeoutSeconds > 0) {
          timer = setTimeout(() => {
            cancel()
            settle({ stdout, stderr, code: -1, timedOut: true })
          }, options.timeoutSeconds * 1000)
          // A fleet run holds one of these per host; none of them should keep
          // the process alive past its own work.
          timer.unref?.()
        }

        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          outRest = drain(outRest, chunk, (line) => options.onStdout?.(line))
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
          errRest = drain(errRest, chunk, (line) => options.onStderr?.(line))
        })
        stream.on('close', (code: number | null) => {
          if (outRest) options.onStdout?.(outRest)
          if (errRest) options.onStderr?.(errRest)
          settle({ stdout, stderr, code: code ?? -1, timedOut: false })
        })

        if (options.stdin !== undefined) stream.end(options.stdin)
      })
    })

    return { finished, cancel: () => cancel() }
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
