import { knownHostsPath } from '@diskpush/database'
import { SftpBrowser, SshSession } from '@diskpush/ssh-core'
import type { Connection } from '@diskpush/schemas'
import { BrowserWindow, dialog } from 'electron'

/**
 * SSH sessions are pooled per connection so browsing does not reconnect on
 * every directory change.
 */
const sessions = new Map<string, Promise<SshSession>>()

export async function sessionFor(connection: Connection): Promise<SshSession> {
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

export async function browserFor(connection: Connection): Promise<SftpBrowser> {
  return SftpBrowser.open(await sessionFor(connection))
}

export function dropSession(connectionId: string): void {
  const existing = sessions.get(connectionId)
  sessions.delete(connectionId)
  void existing?.then((session) => session.close()).catch(() => {})
}

export function closeAllSessions(): void {
  for (const id of [...sessions.keys()]) dropSession(id)
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
