/**
 * A small S3 client: the dozen operations a file manager and a sync engine
 * need, over `fetch`, signed with SigV4.
 */
import { createHash } from 'node:crypto'
import { EMPTY_SHA256, UNSIGNED_PAYLOAD, signRequest, uriEncode, type Credentials } from './sigv4.js'
import { xmlBlocks, xmlText } from './xml.js'

export type S3Settings = {
  /** `https://<account>.r2.cloudflarestorage.com`, `http://127.0.0.1:9000` … Null is AWS for `region`. */
  endpoint: string | null
  /** `us-east-1`; `auto` for R2. */
  region: string
  bucket: string
  /** Path-style (`endpoint/bucket/key`) rather than virtual-hosted (`bucket.endpoint/key`). Null decides. */
  pathStyle: boolean | null
}

export type S3Object = {
  key: string
  size: number
  lastModified: Date
  etag: string
}

export type S3ObjectHead = S3Object & {
  /** The file's own modification time, as DiskPush stored it on upload (`x-amz-meta-mtime`, epoch ms). */
  mtimeMs: number | null
  /** `x-amz-meta-md5`, when DiskPush stored one. */
  md5: string | null
  contentType: string | null
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly key?: string,
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

export type Fetch = typeof fetch

/** The AWS endpoint for a region. */
export function awsEndpoint(region: string): string {
  return region === 'us-east-1' ? 'https://s3.amazonaws.com' : `https://s3.${region}.amazonaws.com`
}

/** What a connection's endpoint actually resolves to, for display and for `host`. */
export function endpointUrl(settings: Pick<S3Settings, 'endpoint' | 'region'>): URL {
  return new URL(settings.endpoint ?? awsEndpoint(settings.region))
}

/**
 * Path-style unless this is AWS with a DNS-safe bucket name. Every
 * S3-compatible server accepts path-style; AWS wants virtual-hosted, and
 * cannot serve a dotted bucket name that way over TLS.
 */
export function usesPathStyle(settings: S3Settings): boolean {
  if (settings.pathStyle !== null) return settings.pathStyle
  if (settings.endpoint !== null) return true
  return settings.bucket.includes('.')
}

export const MAX_SINGLE_PUT = 16 * 1024 * 1024
const MIN_PART = 16 * 1024 * 1024
const MAX_PARTS = 9_000

/** Part size for a multipart upload of `size` bytes: 16 MiB, or bigger to stay under S3's 10,000-part ceiling. */
export function partSizeFor(size: number): number {
  const needed = Math.ceil(size / MAX_PARTS)
  return Math.max(MIN_PART, Math.ceil(needed / (1024 * 1024)) * 1024 * 1024)
}

type RequestOptions = {
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: Uint8Array
  /** Statuses that are not errors. Default: 2xx. */
  accept?: number[]
  signal?: AbortSignal
}

export class S3Client {
  private readonly fetchImpl: Fetch

  constructor(
    readonly settings: S3Settings,
    private readonly credentials: Credentials,
    options: { fetch?: Fetch } = {},
  ) {
    if (!settings.bucket) throw new Error('An S3 connection needs a bucket.')
    if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('S3 credentials need an access key id and a secret.')
    this.fetchImpl = options.fetch ?? fetch
  }

  /** The request URL for an object key (or the bucket, for ''). */
  url(key: string, query: Record<string, string> = {}): URL {
    const base = endpointUrl(this.settings)
    const encodedKey = uriEncode(key, true)
    const basePath = base.pathname.replace(/\/+$/, '')
    let url: URL
    if (usesPathStyle(this.settings)) {
      url = new URL(`${base.protocol}//${base.host}${basePath}/${uriEncode(this.settings.bucket)}${key ? `/${encodedKey}` : '/'}`)
    } else {
      url = new URL(`${base.protocol}//${this.settings.bucket}.${base.host}${basePath}/${encodedKey}`)
    }
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return url
  }

  async request(method: string, key: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(key, options.query)
    const payloadHash = options.body ? UNSIGNED_PAYLOAD : EMPTY_SHA256
    const headers = signRequest({
      method,
      url,
      headers: options.headers ?? {},
      region: this.settings.region,
      credentials: this.credentials,
      payloadHash,
    })
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.body ? { body: options.body } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      // fetch says only "fetch failed"; the reason is on `cause`.
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      const why = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))
      throw new S3Error(0, 'NetworkError', `Could not reach ${url.origin}: ${why}. Check the endpoint URL and your connection.`, key)
    }
    const accept = options.accept ?? []
    if (!response.ok && !accept.includes(response.status)) throw await this.error(response, key)
    return response
  }

  private async error(response: Response, key: string): Promise<S3Error> {
    const text = await response.text().catch(() => '')
    const code = xmlText(text, 'Code') ?? `HTTP${response.status}`
    const detail = xmlText(text, 'Message') ?? response.statusText
    const hint =
      code === 'SignatureDoesNotMatch'
        ? ' Check the secret access key, and the region.'
        : code === 'InvalidAccessKeyId'
          ? ' Check the access key id.'
          : code === 'NoSuchBucket'
            ? ` Check the bucket name "${this.settings.bucket}".`
            : code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed'
              ? ' The bucket is in another region; set the region.'
              : ''
    return new S3Error(response.status, code, `S3 ${code}${key ? ` (${key})` : ''}: ${detail.replace(/\.?$/, '.')}${hint}`, key)
  }

  /** Throws unless the bucket exists and these credentials can reach it. */
  async checkBucket(signal?: AbortSignal): Promise<void> {
    await this.list({ maxKeys: 1, ...(signal ? { signal } : {}) })
  }

  async list(options: { prefix?: string; delimiter?: string; token?: string | null; maxKeys?: number; signal?: AbortSignal } = {}) {
    const query: Record<string, string> = { 'list-type': '2' }
    if (options.prefix) query.prefix = options.prefix
    if (options.delimiter) query.delimiter = options.delimiter
    if (options.token) query['continuation-token'] = options.token
    if (options.maxKeys) query['max-keys'] = String(options.maxKeys)
    const response = await this.request('GET', '', { query, ...(options.signal ? { signal: options.signal } : {}) })
    const text = await response.text()
    const objects: S3Object[] = xmlBlocks(text, 'Contents').map((block) => ({
      key: xmlText(block, 'Key') ?? '',
      size: Number(xmlText(block, 'Size') ?? 0),
      lastModified: new Date(xmlText(block, 'LastModified') ?? 0),
      etag: (xmlText(block, 'ETag') ?? '').replace(/"/g, ''),
    }))
    const prefixes = xmlBlocks(text, 'CommonPrefixes').map((block) => xmlText(block, 'Prefix') ?? '')
    const truncated = xmlText(text, 'IsTruncated') === 'true'
    return { objects, prefixes, next: truncated ? xmlText(text, 'NextContinuationToken') : null }
  }

  /** Every object (and common prefix) under `prefix`, page after page. */
  async *listAll(prefix: string, options: { delimiter?: string; signal?: AbortSignal } = {}) {
    let token: string | null = null
    do {
      const page: Awaited<ReturnType<S3Client['list']>> = await this.list({ prefix, token, ...options })
      yield page
      token = page.next
    } while (token)
  }

  async head(key: string, signal?: AbortSignal): Promise<S3ObjectHead | null> {
    const response = await this.request('HEAD', key, { accept: [404], ...(signal ? { signal } : {}) })
    if (response.status === 404) return null
    return headFromResponse(key, response)
  }

  async get(key: string, options: { range?: string; signal?: AbortSignal } = {}): Promise<Response> {
    return this.request('GET', key, {
      ...(options.range ? { headers: { range: options.range } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  async put(key: string, body: Uint8Array, options: { metadata?: Record<string, string>; contentType?: string; signal?: AbortSignal } = {}) {
    const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/octet-stream' }
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`x-amz-meta-${name}`] = value
    const response = await this.request('PUT', key, { body, headers, ...(options.signal ? { signal: options.signal } : {}) })
    return (response.headers.get('etag') ?? '').replace(/"/g, '')
  }

  async createMultipart(key: string, options: { metadata?: Record<string, string>; contentType?: string; signal?: AbortSignal } = {}): Promise<string> {
    const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/octet-stream' }
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`x-amz-meta-${name}`] = value
    const response = await this.request('POST', key, { query: { uploads: '' }, headers, ...(options.signal ? { signal: options.signal } : {}) })
    const id = xmlText(await response.text(), 'UploadId')
    if (!id) throw new S3Error(500, 'NoUploadId', `S3 did not return an upload id for ${key}.`, key)
    return id
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array, signal?: AbortSignal): Promise<string> {
    const response = await this.request('PUT', key, {
      query: { partNumber: String(partNumber), uploadId },
      body,
      ...(signal ? { signal } : {}),
    })
    return response.headers.get('etag') ?? ''
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, signal?: AbortSignal) {
    const xml = `<CompleteMultipartUpload>${parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`
    const response = await this.request('POST', key, {
      query: { uploadId },
      body: Buffer.from(xml),
      headers: { 'content-type': 'application/xml' },
      ...(signal ? { signal } : {}),
    })
    // S3 can answer 200 with an error document in the body.
    const text = await response.text()
    if (/<Error>/.test(text)) throw new S3Error(500, xmlText(text, 'Code') ?? 'InternalError', `S3 could not complete ${key}: ${xmlText(text, 'Message') ?? text}`, key)
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.request('DELETE', key, { query: { uploadId }, accept: [404] })
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.request('DELETE', key, { accept: [404], ...(signal ? { signal } : {}) })
  }

  /** Deletes up to any number of keys, 1,000 per request. Returns the keys S3 refused, with why. */
  async deleteMany(keys: readonly string[], signal?: AbortSignal): Promise<Array<{ key: string; message: string }>> {
    const failed: Array<{ key: string; message: string }> = []
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      const xml = `<Delete><Quiet>true</Quiet>${batch.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('')}</Delete>`
      const body = Buffer.from(xml)
      const response = await this.request('POST', '', {
        query: { delete: '' },
        body,
        headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body).digest('base64') },
        ...(signal ? { signal } : {}),
      })
      for (const block of xmlBlocks(await response.text(), 'Error')) {
        failed.push({ key: xmlText(block, 'Key') ?? '', message: `${xmlText(block, 'Code')}: ${xmlText(block, 'Message')}` })
      }
    }
    return failed
  }

  /** Server-side copy within the bucket, metadata included. Objects over 5 GB need multipart copy, which this does not do. */
  async copy(from: string, to: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('PUT', to, {
      headers: { 'x-amz-copy-source': `/${uriEncode(this.settings.bucket)}/${uriEncode(from, true)}`, 'x-amz-metadata-directive': 'COPY' },
      ...(signal ? { signal } : {}),
    })
    const text = await response.text()
    if (/<Error>/.test(text)) throw new S3Error(500, xmlText(text, 'Code') ?? 'InternalError', `S3 could not copy ${from}: ${xmlText(text, 'Message') ?? text}`, from)
  }
}

export function headFromResponse(key: string, response: Response): S3ObjectHead {
  const mtime = Number(response.headers.get('x-amz-meta-mtime'))
  return {
    key,
    size: Number(response.headers.get('content-length') ?? 0),
    lastModified: new Date(response.headers.get('last-modified') ?? 0),
    etag: (response.headers.get('etag') ?? '').replace(/"/g, ''),
    mtimeMs: Number.isFinite(mtime) && mtime > 0 ? mtime : null,
    md5: response.headers.get('x-amz-meta-md5'),
    contentType: response.headers.get('content-type'),
  }
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
