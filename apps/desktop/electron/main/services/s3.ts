import { MissingS3Credentials, S3_SECRET_NAME, s3ClientFor, type S3Client } from '@diskpush/s3-core'
import type { S3Connection } from '@diskpush/schemas'
import { store } from './store.js'

/**
 * S3 clients, one per saved bucket connection.
 *
 * A client is only settings plus credentials (there is no socket to keep warm),
 * but building one reads the stored secret, so it is cached and dropped with
 * the SSH sessions whenever the connection is saved or deleted.
 *
 * The secret access key is read here, in the main process, and handed straight
 * to the client. It never travels back over IPC.
 */
const clients = new Map<string, Promise<S3Client>>()

export function s3ClientForConnection(connection: S3Connection): Promise<S3Client> {
  const existing = clients.get(connection.id)
  if (existing) return existing
  const created = (async () => {
    const secret = await (await store()).getConnectionSecret(connection.id, S3_SECRET_NAME)
    try {
      return s3ClientFor(connection.s3, secret, process.env, connection.name)
    } catch (error) {
      if (error instanceof MissingS3Credentials) {
        // The package's message points at the CLI; this one points at the form.
        throw new Error(
          `${connection.name}: no S3 credentials. Add an access key ID and secret access key in Servers, ` +
            'or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment DiskPush starts from.',
        )
      }
      throw error
    }
  })()
  clients.set(connection.id, created)
  // A failure is not cached: the next attempt re-reads the (perhaps now saved) secret.
  created.catch(() => {
    if (clients.get(connection.id) === created) clients.delete(connection.id)
  })
  return created
}

/**
 * A pane path as a path inside a bucket. A bucket has no home directory, so
 * `.` (what a remote pane starts on when no default path is set) is the root,
 * and a relative path is taken from the root. A trailing slash is kept: it
 * means what it means to rsync.
 */
export function bucketPath(path: string): string {
  if (path === '.' || path === './' || path === '') return '/'
  const trimmed = path.startsWith('./') ? path.slice(2) : path
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function dropS3Client(connectionId: string): void {
  clients.delete(connectionId)
}

export function dropAllS3Clients(): void {
  clients.clear()
}
