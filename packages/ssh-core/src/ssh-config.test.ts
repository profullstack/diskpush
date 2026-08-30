import { describe, expect, it } from 'vitest'
import { parseSshConfig } from './ssh-config.js'

const CONFIG = `
# personal
Host production
    HostName 203.0.113.10
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_prod

Host media-01 backup-02
    User anthony
    ProxyJump bastion
    ServerAliveInterval 30

Host *.internal
    User root

Host *
    ServerAliveInterval 60
`

describe('parseSshConfig', () => {
  it('reads a host block', () => {
    const hosts = parseSshConfig(CONFIG)
    expect(hosts.find((h) => h.alias === 'production')).toMatchObject({
      hostName: '203.0.113.10',
      user: 'deploy',
      port: 2222,
      identityFile: '~/.ssh/id_prod',
    })
  })

  it('expands multiple aliases on one Host line', () => {
    const hosts = parseSshConfig(CONFIG).map((h) => h.alias)
    expect(hosts).toContain('media-01')
    expect(hosts).toContain('backup-02')
  })

  it('skips wildcard patterns, which are not importable as one connection', () => {
    const hosts = parseSshConfig(CONFIG).map((h) => h.alias)
    expect(hosts).not.toContain('*')
    expect(hosts).not.toContain('*.internal')
  })

  it('reads ProxyJump and ServerAliveInterval', () => {
    const backup = parseSshConfig(CONFIG).find((h) => h.alias === 'backup-02')
    expect(backup).toMatchObject({ proxyJump: 'bastion', serverAliveInterval: 30 })
  })

  it('applies a multi-alias Host block to every alias it names', () => {
    const hosts = parseSshConfig(CONFIG)
    expect(hosts.find((h) => h.alias === 'media-01')).toMatchObject({ user: 'anthony', proxyJump: 'bastion' })
    expect(hosts.find((h) => h.alias === 'backup-02')).toMatchObject({ user: 'anthony', proxyJump: 'bastion' })
  })

  it('does not leak a skipped wildcard block into the host before it', () => {
    const backup = parseSshConfig(CONFIG).find((h) => h.alias === 'backup-02')
    expect(backup!.serverAliveInterval).toBe(30)
  })

  it('accepts the key=value form OpenSSH also allows', () => {
    const hosts = parseSshConfig('Host web\n  HostName=198.51.100.4\n  Port=2200\n')
    expect(hosts[0]).toMatchObject({ hostName: '198.51.100.4', port: 2200 })
  })

  it('returns nothing for an empty config', () => {
    expect(parseSshConfig('')).toEqual([])
  })
})

describe('quoted values', () => {
  /**
   * `IdentityFile "/path with spaces/key"` is valid ssh_config. Keeping the
   * quotes makes the path a file that cannot exist, and the ENOENT names a
   * path that looks plainly correct — quotes and all.
   */
  it('drops double quotes around a value', () => {
    const [host] = parseSshConfig('Host a\n  IdentityFile "/home/you/.ssh/my key"\n')
    expect(host?.identityFile).toBe('/home/you/.ssh/my key')
  })

  it('drops single quotes too', () => {
    const [host] = parseSshConfig("Host a\n  HostName 'example.com'\n")
    expect(host?.hostName).toBe('example.com')
  })

  it('leaves an unquoted value untouched', () => {
    const [host] = parseSshConfig('Host a\n  IdentityFile ~/.ssh/id_rsa\n')
    expect(host?.identityFile).toBe('~/.ssh/id_rsa')
  })
})
