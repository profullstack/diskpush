import { S3_SECRET_NAME, s3DisplayFields } from '@diskpush/s3-core'
import { sshConfigConnections } from '@diskpush/ssh-core'
import { isS3Connection, type Connection } from '@diskpush/schemas'
import type { ConnectionInput } from '../../shared/contract.js'
import { store } from './store.js'

/** The id prefix `sshConfigConnections()` gives hosts it reads from ~/.ssh/config. */
const SSH_CONFIG_PREFIX = 'ssh-config:'

/**
 * Resolves a connection id the renderer sent back to us.
 *
 * The picker offers saved connections *and* hosts from ~/.ssh/config, and the
 * latter are deliberately never persisted — so looking only in the database
 * makes every ssh_config host unusable the moment it is selected. Saved rows
 * still win: importing a host and then editing it must not be undone by the
 * file it came from.
 */
export async function resolveConnection(id: string): Promise<Connection | null> {
  const saved = await (await store()).findConnection(id)
  if (saved) return saved
  if (!id.startsWith(SSH_CONFIG_PREFIX)) return null
  return sshConfigConnections().find((connection) => connection.id === id) ?? null
}

/** As `resolveConnection`, for the callers that cannot proceed without one. */
export async function requireConnection(id: string): Promise<Connection> {
  const connection = await resolveConnection(id)
  if (!connection) throw new Error('That connection no longer exists.')
  return connection
}

/**
 * A connection as the renderer may see it. For a bucket, `hasSecret` says
 * whether a secret access key is stored; the key itself never leaves the main
 * process.
 */
export type RendererConnection = Connection & { hasSecret?: boolean }

export async function forRenderer(connection: Connection): Promise<RendererConnection> {
  if (!isS3Connection(connection)) return connection
  const secret = await (await store()).getConnectionSecret(connection.id, S3_SECRET_NAME)
  return { ...connection, hasSecret: secret !== null }
}

/**
 * Saves what the connection form sent.
 *
 * For a bucket, `host`, `username` and `port` are derived from the endpoint
 * and bucket, so every `username@host` label in the app reads `bucket@host`,
 * and the SSH-only fields are reset rather than left over from an edit that
 * switched kinds.
 *
 * The secret is write-only: absent or blank keeps the stored one, `null`
 * clears it. A server keeps no S3 secret, so switching a connection back to
 * SSH removes it.
 */
export async function saveConnectionInput(input: ConnectionInput): Promise<RendererConnection> {
  const db = await store()
  const { s3SecretAccessKey, ...fields } = input

  const saved =
    fields.kind === 's3' && fields.s3
      ? await db.saveConnection({
          ...fields,
          ...s3DisplayFields(fields.s3),
          kind: 's3',
          s3: fields.s3,
          authType: 'agent',
          keyPath: null,
          jumpHost: null,
          rsyncPath: null,
          forwardAgent: false,
        })
      : await db.saveConnection({
          ...fields,
          kind: 'ssh',
          s3: null,
          // The contract refuses an SSH connection without these.
          host: fields.host ?? '',
          username: fields.username ?? '',
        })

  if (saved.kind === 's3') {
    const secret = typeof s3SecretAccessKey === 'string' ? s3SecretAccessKey.trim() : s3SecretAccessKey
    if (secret === null) await db.setConnectionSecret(saved.id, S3_SECRET_NAME, null)
    else if (secret) await db.setConnectionSecret(saved.id, S3_SECRET_NAME, secret)
  } else {
    await db.setConnectionSecret(saved.id, S3_SECRET_NAME, null)
  }
  return forRenderer(saved)
}
