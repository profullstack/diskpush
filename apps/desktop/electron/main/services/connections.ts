import { sshConfigConnections } from '@diskpush/ssh-core'
import type { Connection } from '@diskpush/schemas'
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
