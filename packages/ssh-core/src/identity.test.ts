import { describe, expect, it } from 'vitest'
import {
  agentSocketCandidates,
  defaultIdentityPaths,
  expandTilde,
  findAgentSocket,
  findDefaultIdentities,
  findDefaultIdentity,
} from './identity.js'

const HOME = '/home/you'

describe('expandTilde', () => {
  it('expands a leading ~/', () => {
    expect(expandTilde('~/.ssh/id_ed25519', HOME)).toBe('/home/you/.ssh/id_ed25519')
  })

  it('expands a bare ~', () => {
    expect(expandTilde('~', HOME)).toBe(HOME)
  })

  it('leaves an absolute path alone', () => {
    expect(expandTilde('/etc/ssh/key', HOME)).toBe('/etc/ssh/key')
  })

  it('leaves a ~ that is not at the front alone', () => {
    expect(expandTilde('/tmp/back~up', HOME)).toBe('/tmp/back~up')
  })

  it('leaves ~user alone rather than guessing another home', () => {
    // Resolving it means reading passwd, and /home/<user> is wrong often enough
    // that a wrong path is worse than an unexpanded one.
    expect(expandTilde('~someone/.ssh/id_rsa', HOME)).toBe('~someone/.ssh/id_rsa')
  })
})

describe('findDefaultIdentity', () => {
  it('tries the keys ssh tries, in ssh order', () => {
    expect(defaultIdentityPaths(HOME)).toEqual([
      '/home/you/.ssh/id_ed25519',
      '/home/you/.ssh/id_ecdsa',
      '/home/you/.ssh/id_rsa',
      '/home/you/.ssh/id_dsa',
    ])
  })

  it('prefers ed25519 when several exist', () => {
    expect(findDefaultIdentity(() => true, HOME)).toBe('/home/you/.ssh/id_ed25519')
  })

  it('falls through to the one that is actually there', () => {
    const only = '/home/you/.ssh/id_rsa'
    expect(findDefaultIdentity((path) => path === only, HOME)).toBe(only)
  })

  it('is null when the user has no keys at all', () => {
    expect(findDefaultIdentity(() => false, HOME)).toBeNull()
  })
})

describe('findAgentSocket', () => {
  /**
   * The bug this exists to prevent: agent auth required SSH_AUTH_SOCK to be
   * exported. A desktop app is launched from a session that exports far less
   * than a login shell, so every host with no IdentityFile failed with "no SSH
   * agent is available" — in a terminal, on the same machine, they all worked.
   */
  it('honours SSH_AUTH_SOCK above every guess', () => {
    const env = { SSH_AUTH_SOCK: '/tmp/explicit.sock', XDG_RUNTIME_DIR: '/run/user/1000' }
    expect(findAgentSocket(() => true, env, 1000)).toBe('/tmp/explicit.sock')
  })

  it('finds the systemd agent socket when the variable is missing', () => {
    const socket = '/run/user/1000/ssh-agent.socket'
    expect(findAgentSocket((path) => path === socket, { XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(socket)
  })

  it('finds a gnome-keyring socket too', () => {
    const socket = '/run/user/1000/keyring/ssh'
    expect(findAgentSocket((path) => path === socket, { XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(socket)
  })

  it('derives the runtime directory from the uid when XDG_RUNTIME_DIR is unset', () => {
    expect(agentSocketCandidates({}, 1000)).toContain('/run/user/1000/ssh-agent.socket')
  })

  it('is null when there is no socket anywhere, rather than a path to nothing', () => {
    expect(findAgentSocket(() => false, { XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBeNull()
  })

  it('offers nothing to guess at when there is no runtime directory and no uid', () => {
    expect(agentSocketCandidates({}, null)).toEqual([])
  })
})

describe('findDefaultIdentities', () => {
  /**
   * The bug this exists to prevent: only the first existing key was offered.
   * A host that accepts id_rsa but not id_ed25519 — seed1, in the report that
   * prompted this — rejected the connection outright, while `ssh` to the same
   * host from a terminal succeeded, because ssh offers each identity in turn.
   */
  it('returns every key that exists, in ssh order', () => {
    expect(findDefaultIdentities(() => true, HOME)).toEqual([
      '/home/you/.ssh/id_ed25519',
      '/home/you/.ssh/id_ecdsa',
      '/home/you/.ssh/id_rsa',
      '/home/you/.ssh/id_dsa',
    ])
  })

  it('keeps id_rsa when ed25519 also exists, because the server chooses', () => {
    const present = ['/home/you/.ssh/id_ed25519', '/home/you/.ssh/id_rsa']
    expect(findDefaultIdentities((path) => present.includes(path), HOME)).toEqual(present)
  })

  it('is empty when the user has no keys', () => {
    expect(findDefaultIdentities(() => false, HOME)).toEqual([])
  })

  it('still reports the first one for callers that want just one', () => {
    const only = '/home/you/.ssh/id_rsa'
    expect(findDefaultIdentity((path) => path === only, HOME)).toBe(only)
  })
})
