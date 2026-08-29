import { createHmac } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * known_hosts handling.
 *
 * OpenSSH stores host entries either in the clear or hashed with
 * HMAC-SHA1 (`|1|salt|hash`), and both forms have to be understood or a
 * hashed file looks empty and every host reads as new.
 */

export type KnownHostEntry = {
  /** Plain hostnames on this line, empty when the line is hashed. */
  hosts: string[]
  hashed: { salt: Buffer; digest: Buffer } | null
  keyType: string
  /** Base64 of the public key blob, exactly as stored. */
  key: string
  marker: 'revoked' | 'cert-authority' | null
}

export type HostKeyVerdict =
  | { status: 'trusted' }
  | { status: 'unknown' }
  | { status: 'changed'; expected: string }
  | { status: 'revoked' }

export function parseKnownHosts(contents: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const fields = line.split(/\s+/)
    let index = 0
    let marker: KnownHostEntry['marker'] = null
    if (fields[0] === '@revoked') {
      marker = 'revoked'
      index = 1
    } else if (fields[0] === '@cert-authority') {
      marker = 'cert-authority'
      index = 1
    }

    const hostField = fields[index]
    const keyType = fields[index + 1]
    const key = fields[index + 2]
    if (!hostField || !keyType || !key) continue

    if (hostField.startsWith('|1|')) {
      const [, , saltB64, digestB64] = hostField.split('|')
      if (!saltB64 || !digestB64) continue
      entries.push({
        hosts: [],
        hashed: { salt: Buffer.from(saltB64, 'base64'), digest: Buffer.from(digestB64, 'base64') },
        keyType,
        key,
        marker,
      })
    } else {
      entries.push({ hosts: hostField.split(','), hashed: null, keyType, key, marker })
    }
  }

  return entries
}

/** The name OpenSSH matches on: bare host, or `[host]:port` for a non-default port. */
export function hostPattern(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function matchesHost(entry: KnownHostEntry, pattern: string): boolean {
  if (entry.hashed) {
    const digest = createHmac('sha1', entry.hashed.salt).update(pattern).digest()
    return digest.equals(entry.hashed.digest)
  }
  return entry.hosts.includes(pattern)
}

export function verifyHostKey(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  keyType: string,
  keyBase64: string,
): HostKeyVerdict {
  const pattern = hostPattern(host, port)
  const matching = entries.filter((entry) => matchesHost(entry, pattern))
  if (matching.length === 0) return { status: 'unknown' }

  for (const entry of matching) {
    if (entry.key === keyBase64 && entry.keyType === keyType) {
      return entry.marker === 'revoked' ? { status: 'revoked' } : { status: 'trusted' }
    }
  }

  // A key of the same type under a different value is the case worth shouting
  // about: the host answered, but not with the key we recorded.
  const sameType = matching.find((entry) => entry.keyType === keyType)
  if (sameType) return { status: 'changed', expected: sameType.key }
  return { status: 'unknown' }
}

export function readKnownHosts(path: string): KnownHostEntry[] {
  try {
    return parseKnownHosts(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Trust on first use. Only ever called after the user has seen the fingerprint. */
export function appendKnownHost(path: string, host: string, port: number, keyType: string, keyBase64: string): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${hostPattern(host, port)} ${keyType} ${keyBase64}\n`, { mode: 0o600 })
}
