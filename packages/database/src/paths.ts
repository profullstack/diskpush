import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Desktop and CLI deliberately share one configuration directory: a
 * connection saved in the app has to be usable from a shell script without
 * being re-entered.
 */
export function diskpushHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DISKPUSH_HOME) return env.DISKPUSH_HOME
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'diskpush')
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(diskpushHome(env), 'diskpush.db')
}

export function logsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return env.DISKPUSH_HOME ? join(env.DISKPUSH_HOME, 'logs') : join(stateHome, 'diskpush', 'logs')
}

export function knownHostsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(diskpushHome(env), 'known_hosts')
}
