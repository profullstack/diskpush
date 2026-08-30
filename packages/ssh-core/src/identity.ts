import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Finding the things OpenSSH finds on its own.
 *
 * DiskPush used to require both halves of this to be spelled out: agent
 * authentication meant `SSH_AUTH_SOCK` had to be exported, and a host with no
 * `IdentityFile` in ssh_config had no key at all. Both hold in a terminal and
 * neither holds in a desktop app, which is launched from a session that
 * exports far less than a login shell — so every server that worked in the
 * terminal failed in the window with "no SSH agent is available".
 */

/** `~` at the front of a path, expanded. Anywhere else it is an ordinary character. */
export function expandTilde(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  // `~user/...` is deliberately left alone: resolving another account's home
  // means reading passwd, and guessing `/home/<user>` is wrong often enough.
  return path
}

/**
 * The identity files OpenSSH tries when a host names none, in its order.
 *
 * ssh(1) reads these from ~/.ssh by default; DSA is included because ssh still
 * lists it, and omitting a key someone actually uses is the failure this whole
 * module exists to prevent.
 */
export const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'] as const

export function defaultIdentityPaths(home: string = homedir()): string[] {
  return DEFAULT_IDENTITY_FILES.map((name) => join(home, '.ssh', name))
}

/**
 * Every default identity that exists, in ssh's order.
 *
 * All of them, not the first: ssh(1) offers each identity in turn until the
 * server accepts one, and a host that takes id_rsa but not id_ed25519 is
 * ordinary. Offering only the first key made such a host reject us outright
 * while `ssh` to the same host from a terminal succeeded.
 */
export function findDefaultIdentities(exists: (path: string) => boolean, home: string = homedir()): string[] {
  return defaultIdentityPaths(home).filter((path) => exists(path))
}

/** The first default identity that exists, or null when the user has no keys. */
export function findDefaultIdentity(exists: (path: string) => boolean, home: string = homedir()): string | null {
  return findDefaultIdentities(exists, home)[0] ?? null
}

/**
 * Where an agent socket is likely to be when `SSH_AUTH_SOCK` is not set.
 *
 * `SSH_AUTH_SOCK` wins whenever it is present — it is the only one of these
 * that is a statement of intent rather than a guess. The rest are the sockets
 * the common agents put in the runtime directory: systemd's ssh-agent unit,
 * then gnome-keyring, then the KDE/ssh-agent unit name.
 */
export function agentSocketCandidates(
  env: NodeJS.ProcessEnv = process.env,
  // `null` rather than `undefined` for "no uid": a default parameter fires on
  // undefined, so undefined could not have meant anything else.
  uid: number | null = process.getuid?.() ?? null,
): string[] {
  const candidates: string[] = []
  if (env.SSH_AUTH_SOCK) candidates.push(env.SSH_AUTH_SOCK)

  const runtime = env.XDG_RUNTIME_DIR ?? (uid === null ? null : `/run/user/${uid}`)
  if (runtime) {
    candidates.push(
      join(runtime, 'ssh-agent.socket'),
      join(runtime, 'keyring', 'ssh'),
      join(runtime, 'gcr', 'ssh'),
      join(runtime, 'openssh_agent'),
    )
  }
  return candidates
}

/** The first agent socket that exists, or null. */
export function findAgentSocket(
  exists: (path: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null = process.getuid?.() ?? null,
): string | null {
  return agentSocketCandidates(env, uid).find((path) => exists(path)) ?? null
}
