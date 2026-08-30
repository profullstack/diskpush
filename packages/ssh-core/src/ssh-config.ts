/**
 * A small reader for ~/.ssh/config, used to offer existing hosts for import.
 *
 * This understands the subset DiskPush maps onto a connection. It is not a
 * reimplementation of OpenSSH's matching rules, and it is only ever used to
 * pre-fill a form the user then confirms.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Connection } from '@diskpush/schemas'

export type SshConfigHost = {
  alias: string
  hostName: string | null
  user: string | null
  port: number | null
  identityFile: string | null
  proxyJump: string | null
  serverAliveInterval: number | null
}

const KEYS = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'serveraliveinterval'])

export function parseSshConfig(contents: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  // A `Host` line can name several aliases, and every setting below it applies
  // to all of them, so the active block is a group rather than a single host.
  let group: SshConfigHost[] = []

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = /^(\S+)[\s=]+(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = match[2]!.trim()

    if (key === 'host') {
      // A wildcard block sets defaults across many hosts. Modelling that
      // properly means implementing OpenSSH's first-value-wins matching, which
      // is more than an import helper needs, so the block is skipped outright
      // and its settings are not attributed to whatever came before it.
      const aliases = value.split(/\s+/).filter((alias) => !alias.includes('*') && !alias.includes('?') && !alias.startsWith('!'))
      group = aliases.map((alias) => ({
        alias,
        hostName: null,
        user: null,
        port: null,
        identityFile: null,
        proxyJump: null,
        serverAliveInterval: null,
      }))
      hosts.push(...group)
      continue
    }

    if (group.length === 0 || !KEYS.has(key)) continue
    for (const host of group) applySetting(host, key, value)
  }

  return hosts
}

function applySetting(host: SshConfigHost, key: string, value: string): void {
  switch (key) {
    case 'hostname':
      host.hostName ??= value
      break
    case 'user':
      host.user ??= value
      break
    case 'port':
      host.port ??= Number(value) || null
      break
    case 'identityfile':
      host.identityFile ??= value
      break
    case 'proxyjump':
      host.proxyJump ??= value
      break
    case 'serveraliveinterval':
      host.serverAliveInterval ??= Number(value) || null
      break
    default:
      break
  }
}

/**
 * The hosts in ~/.ssh/config, shaped as unsaved connections.
 *
 * Shared by the CLI and the desktop app so both offer the same servers. They
 * are not persisted: the id records where each came from, and a saved
 * connection of the same name takes precedence, because it carries a port, a
 * key and a default path that an ssh_config entry does not.
 */
export function sshConfigConnections(env: NodeJS.ProcessEnv = process.env): Connection[] {
  const path = env.DISKPUSH_SSH_CONFIG ?? join(homedir(), '.ssh', 'config')

  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  const now = new Date().toISOString()
  const seen = new Set<string>()

  return parseSshConfig(contents)
    .filter((host) => host.hostName || host.user)
    .filter((host) => {
      // ~/.ssh/config really does list some aliases more than once.
      if (seen.has(host.alias)) return false
      seen.add(host.alias)
      return true
    })
    .map((host): Connection => {
      const identity = host.identityFile ? host.identityFile.replace(/^~/, homedir()) : null
      return {
        id: `ssh-config:${host.alias}`,
        name: host.alias,
        host: host.hostName ?? host.alias,
        port: host.port ?? 22,
        username: host.user ?? env.USER ?? 'root',
        authType: identity ? 'key' : 'agent',
        keyPath: identity,
        defaultLocalPath: null,
        defaultRemotePath: null,
        jumpHost: host.proxyJump,
        rsyncPath: null,
        connectTimeoutSeconds: 15,
        keepaliveSeconds: host.serverAliveInterval ?? 30,
        forwardAgent: false,
        tags: ['ssh-config'],
        notes: `From ${path}`,
        createdAt: now,
        updatedAt: now,
      }
    })
}
