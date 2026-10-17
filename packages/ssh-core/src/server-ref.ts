import type { Connection } from '@diskpush/schemas'

/** The id prefix `sshConfigConnections()` gives the hosts it reads from ~/.ssh/config. */
const SSH_CONFIG_ID = 'ssh-config:'

/**
 * A connection as plugins see it (plugin-api's `ServerRef`): enough to build
 * an `ssh` command line, and nothing secret. Kept structural so ssh-core does
 * not depend on the plugin API.
 */
export function toServerRef(connection: Connection): {
  name: string
  host: string
  port: number
  username: string
  keyPath: string | null
  jumpHost: string | null
  sshConfigAlias: string | null
  passwordAuth: boolean
} {
  return {
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    keyPath: connection.keyPath,
    jumpHost: connection.jumpHost,
    sshConfigAlias: connection.id.startsWith(SSH_CONFIG_ID) ? connection.id.slice(SSH_CONFIG_ID.length) : null,
    passwordAuth: connection.authType === 'password',
  }
}
