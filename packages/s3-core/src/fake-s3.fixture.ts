/**
 * An in-memory S3 for tests: the operations S3Client uses, path-style, on a
 * real local port. It checks that requests are signed (an Authorization
 * header for the right access key) but not the signature itself; the SigV4
 * known-answer test and the live rclone suite cover that.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Stored = { body: Buffer; meta: Record<string, string>; contentType: string; lastModified: Date; etag: string }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export class FakeS3 {
  readonly objects = new Map<string, Stored>()
  private uploads = new Map<string, { key: string; meta: Record<string, string>; parts: Map<number, Buffer> }>()
  private server: Server | null = null
  url = ''
  requests: Array<{ method: string; path: string; query: string }> = []

  constructor(
    readonly bucket = 'test-bucket',
    readonly accessKeyId = 'AKIDFAKE',
  ) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        res.statusCode = 500
        res.end(String(error))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  /** Puts an object directly, as another client would have. */
  seed(key: string, body: string | Buffer, meta: Record<string, string> = {}, lastModified = new Date()): void {
    const data = Buffer.from(body)
    this.objects.set(key, { body: data, meta, contentType: 'application/octet-stream', lastModified, etag: createHash('md5').update(data).digest('hex') })
  }

  private error(res: ServerResponse, status: number, code: string, message = code) {
    res.statusCode = status
    res.setHeader('content-type', 'application/xml')
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`)
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.url)
    this.requests.push({ method: req.method ?? '', path: url.pathname, query: url.search })
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/`)) return this.error(res, 403, 'InvalidAccessKeyId')
    const [, bucket, ...rest] = url.pathname.split('/')
    if (decodeURIComponent(bucket ?? '') !== this.bucket) return this.error(res, 404, 'NoSuchBucket')
    const key = decodeURIComponent(rest.join('/'))
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const q = url.searchParams
    const meta = () => {
      const out: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) if (name.startsWith('x-amz-meta-')) out[name.slice(11)] = String(value)
      return out
    }
    const send = (stored: Stored, bodyToo: boolean) => {
      res.setHeader('etag', `"${stored.etag}"`)
      res.setHeader('last-modified', stored.lastModified.toUTCString())
      res.setHeader('content-type', stored.contentType)
      for (const [name, value] of Object.entries(stored.meta)) res.setHeader(`x-amz-meta-${name}`, value)
      const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''))
      if (range && bodyToo) {
        const start = Number(range[1])
        if (start >= stored.body.length) return this.error(res, 416, 'InvalidRange')
        const end = Math.min(range[2] ? Number(range[2]) : stored.body.length - 1, stored.body.length - 1)
        res.statusCode = 206
        res.setHeader('content-range', `bytes ${start}-${end}/${stored.body.length}`)
        res.setHeader('content-length', end - start + 1)
        return res.end(stored.body.subarray(start, end + 1))
      }
      res.setHeader('content-length', stored.body.length)
      res.end(bodyToo ? stored.body : undefined)
    }

    if (req.method === 'GET' && !key && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? ''
      const delimiter = q.get('delimiter') ?? ''
      const max = Number(q.get('max-keys') ?? 1000)
      const after = q.get('continuation-token') ?? ''
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const contents: string[] = []
      const prefixes = new Set<string>()
      let truncated = false
      let last = ''
      for (const k of keys) {
        if (after && k <= after) continue
        const restKey = k.slice(prefix.length)
        const at = delimiter ? restKey.indexOf(delimiter) : -1
        if (contents.length + prefixes.size >= max) {
          truncated = true
          break
        }
        if (at !== -1) prefixes.add(prefix + restKey.slice(0, at + 1))
        else contents.push(k)
        last = k
      }
      const body = `<?xml version="1.0"?><ListBucketResult><Name>${this.bucket}</Name><IsTruncated>${truncated}</IsTruncated>${
        truncated ? `<NextContinuationToken>${xml(last)}</NextContinuationToken>` : ''
      }${contents
        .map((k) => {
          const o = this.objects.get(k)!
          return `<Contents><Key>${xml(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size></Contents>`
        })
        .join('')}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`
      res.setHeader('content-type', 'application/xml')
      return res.end(body)
    }
    if (req.method === 'POST' && !key && q.has('delete')) {
      const keys = [...body.toString().matchAll(/<Key>(.*?)<\/Key>/g)].map((m) => m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
      for (const k of keys) this.objects.delete(k)
      return res.end('<?xml version="1.0"?><DeleteResult></DeleteResult>')
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = randomUUID()
      this.uploads.set(id, { key, meta: meta(), parts: new Map() })
      return res.end(`<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
    }
    if (req.method === 'PUT' && q.has('partNumber')) {
      const upload = this.uploads.get(q.get('uploadId') ?? '')
      if (!upload) return this.error(res, 404, 'NoSuchUpload')
      upload.parts.set(Number(q.get('partNumber')), body)
      res.setHeader('etag', `"${createHash('md5').update(body).digest('hex')}"`)
      return res.end()
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const upload = this.uploads.get(q.get('uploadId')!)
      if (!upload) return this.error(res, 404, 'NoSuchUpload')
      const data = Buffer.concat([...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b))
      this.objects.set(upload.key, { body: data, meta: upload.meta, contentType: 'application/octet-stream', lastModified: new Date(), etag: `${createHash('md5').update(data).digest('hex')}-${upload.parts.size}` })
      this.uploads.delete(q.get('uploadId')!)
      return res.end('<?xml version="1.0"?><CompleteMultipartUploadResult></CompleteMultipartUploadResult>')
    }
    if (req.method === 'DELETE' && q.has('uploadId')) {
      this.uploads.delete(q.get('uploadId')!)
      res.statusCode = 204
      return res.end()
    }
    if (req.method === 'PUT') {
      const copySource = req.headers['x-amz-copy-source']
      if (copySource) {
        const from = decodeURIComponent(String(copySource)).replace(`/${this.bucket}/`, '')
        const source = this.objects.get(from)
        if (!source) return this.error(res, 404, 'NoSuchKey')
        this.objects.set(key, { ...source, lastModified: new Date() })
        return res.end('<?xml version="1.0"?><CopyObjectResult></CopyObjectResult>')
      }
      const etag = createHash('md5').update(body).digest('hex')
      this.objects.set(key, { body, meta: meta(), contentType: String(req.headers['content-type'] ?? 'application/octet-stream'), lastModified: new Date(), etag })
      res.setHeader('etag', `"${etag}"`)
      return res.end()
    }
    const stored = this.objects.get(key)
    if (req.method === 'DELETE') {
      this.objects.delete(key)
      res.statusCode = 204
      return res.end()
    }
    if (!stored) {
      if (req.method === 'HEAD') {
        res.statusCode = 404
        return res.end()
      }
      return this.error(res, 404, 'NoSuchKey')
    }
    if (req.method === 'HEAD') return send(stored, false)
    if (req.method === 'GET') return send(stored, true)
    return this.error(res, 405, 'MethodNotAllowed')
  }
}
