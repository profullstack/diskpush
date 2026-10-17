/**
 * AWS Signature Version 4 for S3, by hand.
 *
 * DiskPush talks to S3-compatible storage (AWS, Cloudflare R2, Backblaze B2,
 * MinIO, Wasabi, rclone …) with nothing but `fetch` and `node:crypto`, so the
 * same code runs in the CLI (Node 24) and the desktop app's main process
 * (Electron's Node 20) and adds no SDK to either download.
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
import { createHash, createHmac } from 'node:crypto'

export type Credentials = {
  accessKeyId: string
  secretAccessKey: string
  /** For temporary (STS) credentials. */
  sessionToken?: string | null
}

/** Payload hash for bodies DiskPush does not hash. Accepted by every S3 we target. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/**
 * RFC 3986 encoding as SigV4 wants it: everything but unreserved characters,
 * `/` kept when encoding a path.
 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = ''
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === '/')) out += char
    else for (const byte of Buffer.from(char, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** `20261017T031500Z` and `20261017`. */
export function amzDate(date: Date): { stamp: string; day: string } {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { stamp, day: stamp.slice(0, 8) }
}

export type SignInput = {
  method: string
  url: URL
  headers: Record<string, string>
  region: string
  credentials: Credentials
  payloadHash: string
  now?: Date
  service?: string
}

/**
 * Returns the headers to send: the caller's, plus host, x-amz-date,
 * x-amz-content-sha256, the session token if any, and Authorization.
 * Query parameters must already be on `url`.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3'
  const { stamp, day } = amzDate(input.now ?? new Date())
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.headers)) headers[key.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ')
  headers.host = input.url.host
  headers['x-amz-date'] = stamp
  headers['x-amz-content-sha256'] = input.payloadHash
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken

  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('')
  const signedHeaders = names.join(';')
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  // The URL's pathname is already percent-encoded by whoever built it (see
  // S3Client.url); S3 signs it as sent, without encoding it a second time.
  const canonicalRequest = [input.method, input.url.pathname || '/', query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n')

  const scope = `${day}/${input.region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  delete headers.host // fetch sets it, and refuses it as a header
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}
