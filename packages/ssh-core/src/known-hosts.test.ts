import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hostPattern, parseKnownHosts, verifyHostKey } from './known-hosts.js'
import { keyTypeOf, sha256Fingerprint } from './fingerprint.js'

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIDifferentKeyAAAAAAAAAAAAAAAAAAAAAAAA'

function hashedLine(host: string, keyType: string, key: string): string {
  const salt = randomBytes(20)
  const digest = createHmac('sha1', salt).update(host).digest()
  return `|1|${salt.toString('base64')}|${digest.toString('base64')} ${keyType} ${key}`
}

describe('parseKnownHosts', () => {
  it('reads plain entries and comma-separated aliases', () => {
    const entries = parseKnownHosts(`# a comment\nexample.com,192.0.2.1 ssh-ed25519 ${KEY_A}\n`)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.hosts).toEqual(['example.com', '192.0.2.1'])
    expect(entries[0]!.keyType).toBe('ssh-ed25519')
  })

  it('reads hashed entries', () => {
    const entries = parseKnownHosts(hashedLine('example.com', 'ssh-ed25519', KEY_A))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.hashed).not.toBeNull()
    expect(entries[0]!.hosts).toEqual([])
  })

  it('reads markers', () => {
    const entries = parseKnownHosts(`@revoked example.com ssh-ed25519 ${KEY_A}`)
    expect(entries[0]!.marker).toBe('revoked')
  })

  it('skips blank and malformed lines', () => {
    expect(parseKnownHosts('\n\n   \nnotenoughfields\n')).toEqual([])
  })
})

describe('hostPattern', () => {
  it('brackets a non-default port the way OpenSSH does', () => {
    expect(hostPattern('example.com', 22)).toBe('example.com')
    expect(hostPattern('example.com', 2222)).toBe('[example.com]:2222')
  })
})

describe('verifyHostKey', () => {
  it('trusts a matching plain entry', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}`)
    expect(verifyHostKey(entries, 'example.com', 22, 'ssh-ed25519', KEY_A)).toEqual({ status: 'trusted' })
  })

  it('trusts a matching hashed entry', () => {
    const entries = parseKnownHosts(hashedLine('example.com', 'ssh-ed25519', KEY_A))
    expect(verifyHostKey(entries, 'example.com', 22, 'ssh-ed25519', KEY_A)).toEqual({ status: 'trusted' })
  })

  it('reports an unknown host as unknown, not as changed', () => {
    const entries = parseKnownHosts(`other.example ssh-ed25519 ${KEY_A}`)
    expect(verifyHostKey(entries, 'example.com', 22, 'ssh-ed25519', KEY_A).status).toBe('unknown')
  })

  it('reports a different key for a known host as changed', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}`)
    const verdict = verifyHostKey(entries, 'example.com', 22, 'ssh-ed25519', KEY_B)
    expect(verdict.status).toBe('changed')
  })

  it('honours a non-default port when matching', () => {
    const entries = parseKnownHosts(`[example.com]:2222 ssh-ed25519 ${KEY_A}`)
    expect(verifyHostKey(entries, 'example.com', 2222, 'ssh-ed25519', KEY_A).status).toBe('trusted')
    expect(verifyHostKey(entries, 'example.com', 22, 'ssh-ed25519', KEY_A).status).toBe('unknown')
  })

  it('reports a revoked key', () => {
    const entries = parseKnownHosts(`@revoked example.com ssh-ed25519 ${KEY_A}`)
    expect(verifyHostKey(entries, 'example.com', 22, 'ssh-ed25519', KEY_A).status).toBe('revoked')
  })
})

describe('fingerprint', () => {
  it('produces the SHA256 form OpenSSH prints', () => {
    const blob = Buffer.from('some key material')
    const fingerprint = sha256Fingerprint(blob)
    expect(fingerprint.startsWith('SHA256:')).toBe(true)
    expect(fingerprint.endsWith('=')).toBe(false)
  })

  it('reads the algorithm name out of a key blob', () => {
    const algorithm = 'ssh-ed25519'
    const blob = Buffer.concat([
      (() => {
        const length = Buffer.alloc(4)
        length.writeUInt32BE(algorithm.length)
        return length
      })(),
      Buffer.from(algorithm),
      Buffer.from('rest of the key'),
    ])
    expect(keyTypeOf(blob)).toBe('ssh-ed25519')
  })

  it('does not crash on a truncated blob', () => {
    expect(keyTypeOf(Buffer.alloc(2))).toBe('unknown')
  })
})
