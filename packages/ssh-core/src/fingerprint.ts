import { createHash } from 'node:crypto'

/** The `SHA256:…` form OpenSSH prints, so a user can compare it to `ssh-keyscan`. */
export function sha256Fingerprint(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

/** Reads the algorithm name out of the front of an SSH public key blob. */
export function keyTypeOf(keyBlob: Buffer): string {
  if (keyBlob.length < 4) return 'unknown'
  const length = keyBlob.readUInt32BE(0)
  if (length <= 0 || length > keyBlob.length - 4) return 'unknown'
  return keyBlob.subarray(4, 4 + length).toString('ascii')
}
