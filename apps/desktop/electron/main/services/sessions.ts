import { knownHostsPath } from '@diskpush/database'
import { S3Browser } from '@diskpush/s3-core'
import { SftpBrowser, SshSession, type RemoteEntry } from '@diskpush/ssh-core'
import { isS3Connection, type Connection } from '@diskpush/schemas'
import { BrowserWindow, dialog } from 'electron'
import { dropAllS3Clients, dropS3Client, s3ClientForConnection } from './s3.js'

/**
 * What the file operations in ipc.ts need from a remote pane, whichever kind
 * of connection is behind it. SftpBrowser and S3Browser both satisfy it; the
 * entries they return have the same shape.
 */
export interface RemoteBrowser {
  list(directory: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<RemoteEntry>
  mkdir(path: string): Promise<void>
  createFile(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  removeRecursive(path: string): Promise<void>
  close(): void
}

/**
 * SSH sessions are pooled per connection so browsing does not reconnect on
 * every directory change.
 */
const sessions = new Map<string, Promise<SshSession>>()

export async function sessionFor(connection: Connection): Promise<SshSession> {
  // Everything that reaches for a shell (Fleet, the rsync probe) comes through
  // here, so this is the one place an S3 bucket is turned away from it.
  if (isS3Connection(connection)) throw new Error(`${connection.name} is an S3 bucket, not an SSH server.`)
  const existing = sessions.get(connection.id)
  if (existing) {
    try {
      return await existing
    } catch {
      sessions.delete(connection.id)
    }
  }

  const created = SshSession.connect(connection, {
    knownHostsPath: knownHostsPath(),
    onUnknownHostKey: promptForHostKey,
  })
  sessions.set(connection.id, created)

  try {
    return await created
  } catch (error) {
    sessions.delete(connection.id)
    throw error
  }
}

/**
 * A browser for a remote pane: SFTP over the pooled session for a server, or
 * an S3Browser over the cached client for a bucket. Callers close it either
 * way; for S3 that is a no-op.
 */
export async function browserFor(connection: Connection): Promise<RemoteBrowser> {
  if (isS3Connection(connection)) return new S3Browser(await s3ClientForConnection(connection))
  return SftpBrowser.open(await sessionFor(connection))
}

/** Forgets a connection's session and S3 client, so the next use picks up its saved settings. */
export function dropSession(connectionId: string): void {
  dropS3Client(connectionId)
  const existing = sessions.get(connectionId)
  sessions.delete(connectionId)
  void existing?.then((session) => session.close()).catch(() => {})
}

export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) dropSession(id)
  dropAllS3Clients()
}

/**
 * A first connection shows the fingerprint and asks once. A *changed* key
 * never reaches this prompt: the session layer refuses it outright, because
 * "the key changed, click OK" is not a security decision anyone can make from
 * a dialog.
 */
async function promptForHostKey(details: {
  host: string
  port: number
  keyType: string
  fingerprint: string
}): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'question' as const,
    buttons: ['Cancel', 'Trust and continue'],
    defaultId: 0,
    cancelId: 0,
    title: 'Unknown host key',
    message: `The authenticity of ${details.host} cannot be established.`,
    detail:
      `${details.keyType} key fingerprint:\n${details.fingerprint}\n\n` +
      'Compare this with the fingerprint shown on the server before trusting it. ' +
      'Once trusted, DiskPush will block any future connection where this key has changed.',
  }

  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 1
}
