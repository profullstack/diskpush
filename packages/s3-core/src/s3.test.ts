import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RsyncEvent } from '@diskpush/schemas'
import { FakeS3 } from './fake-s3.fixture.js'
import {
  S3Browser,
  S3Client,
  compileFilter,
  decodeXml,
  keyOf,
  parseRsyncSize,
  partSizeFor,
  runS3Sync,
  signRequest,
  uriEncode,
  usesPathStyle,
  type S3SyncSpec,
} from './index.js'

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `dp-s3-${prefix}-`))

describe('SigV4', () => {
  it('matches the AWS documentation example (GET object with a range)', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('matches the AWS example for a ListObjects query string', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: {},
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(headers.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
  })

  it('encodes keys the way S3 signs them', () => {
    expect(uriEncode('photos/2024/a b+c(1).jpg', true)).toBe('photos/2024/a%20b%2Bc%281%29.jpg')
    expect(uriEncode('é')).toBe('%C3%A9')
  })
})

describe('addressing', () => {
  const client = (settings: Partial<ConstructorParameters<typeof S3Client>[0]>) =>
    new S3Client({ endpoint: null, region: 'us-east-1', bucket: 'b', pathStyle: null, ...settings }, { accessKeyId: 'a', secretAccessKey: 's' })

  it('uses virtual-hosted AWS URLs, path-style elsewhere and for dotted buckets', () => {
    expect(client({}).url('a/b.txt').toString()).toBe('https://b.s3.amazonaws.com/a/b.txt')
    expect(client({ region: 'eu-west-1' }).url('x').toString()).toBe('https://b.s3.eu-west-1.amazonaws.com/x')
    expect(client({ bucket: 'my.site' }).url('x').toString()).toBe('https://s3.amazonaws.com/my.site/x')
    expect(client({ endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto' }).url('x').toString()).toBe('https://acct.r2.cloudflarestorage.com/b/x')
    expect(usesPathStyle({ endpoint: 'https://s3.example', region: 'r', bucket: 'b', pathStyle: false })).toBe(false)
  })

  it('maps browser paths to keys and refuses to climb', () => {
    expect(keyOf('/photos/2024/')).toBe('photos/2024')
    expect(keyOf('/')).toBe('')
    expect(keyOf('/a/../b')).toBe('b')
  })

  it('sizes multipart uploads under the part ceiling', () => {
    expect(partSizeFor(100 * 1024 * 1024)).toBe(16 * 1024 * 1024)
    expect(Math.ceil((5 * 1024 ** 4) / partSizeFor(5 * 1024 ** 4))).toBeLessThanOrEqual(10_000)
  })
})

describe('helpers', () => {
  it('decodes XML entities', () => {
    expect(decodeXml('a &amp; b &lt;c&gt; &#233; &#x41;')).toBe('a & b <c> é A')
  })

  it('applies rsync-style patterns', () => {
    const excluded = compileFilter(['keep.log'], ['*.log', 'node_modules/', '/build', 'cache/**'])
    expect(excluded('a/b/x.log', false)).toBe(true)
    expect(excluded('keep.log', false)).toBe(false)
    expect(excluded('src/node_modules', true)).toBe(true)
    expect(excluded('src/node_modules', false)).toBe(false)
    expect(excluded('build', true)).toBe(true)
    expect(excluded('src/build', true)).toBe(false)
    expect(excluded('cache/a/b', false)).toBe(true)
  })

  it('reads rsync sizes', () => {
    expect(parseRsyncSize('10K')).toBe(10240)
    expect(parseRsyncSize('1MB')).toBe(1_000_000)
    expect(parseRsyncSize('1.5M')).toBe(1572864)
  })
})

/** A real SigV4 server: rclone's `serve s3`, when rclone is installed. */
function findRclone(): string | null {
  if (process.env.DISKPUSH_TEST_RCLONE) return process.env.DISKPUSH_TEST_RCLONE
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (existsSync(join(dir, 'rclone'))) return join(dir, 'rclone')
  return null
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

/** `markers`: the backend stores `dir/` folder-marker objects (real S3, R2, B2, MinIO do; rclone's local disk turns them into files). */
type Backend = { name: string; markers: boolean; start(): Promise<{ client: S3Client; stop(): Promise<void> }> }

const backends: Backend[] = [
  {
    name: 'fake',
    markers: true,
    async start() {
      const fake = await new FakeS3().start()
      return {
        client: new S3Client({ endpoint: fake.url, region: 'us-east-1', bucket: fake.bucket, pathStyle: true }, { accessKeyId: fake.accessKeyId, secretAccessKey: 'secret' }),
        stop: () => fake.stop(),
      }
    },
  },
]
const rclone = findRclone()
if (rclone) {
  backends.push({
    name: 'rclone serve s3',
    markers: false,
    async start() {
      const root = temp('rclone')
      mkdirSync(join(root, 'bucket'))
      const port = await freePort()
      const child: ChildProcess = spawn(rclone, ['serve', 's3', '--auth-key', 'AKIDLIVE,livesecret', '--addr', `127.0.0.1:${port}`, root], { stdio: 'ignore' })
      const client = new S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', bucket: 'bucket', pathStyle: true }, { accessKeyId: 'AKIDLIVE', secretAccessKey: 'livesecret' })
      for (let i = 0; i < 50; i++) {
        try {
          await client.checkBucket()
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      return { client, stop: async () => void child.kill() }
    },
  })
}

async function collect(spec: S3SyncSpec): Promise<RsyncEvent[]> {
  const events: RsyncEvent[] = []
  for await (const event of runS3Sync(spec).events) events.push(event)
  return events
}
const changes = (events: RsyncEvent[]) =>
  events.flatMap((e) => (e.type === 'change' ? [`${e.change.action} ${e.change.path}`] : [])).sort()
const exitOf = (events: RsyncEvent[]) => events.find((e) => e.type === 'exit') as Extract<RsyncEvent, { type: 'exit' }>

for (const backend of backends) {
  describe(`S3 against ${backend.name}`, () => {
    let client: S3Client
    let stop: () => Promise<void>
    let n = 0
    const fresh = () => `/run${++n}`
    beforeAll(async () => {
      ;({ client, stop } = await backend.start())
    })
    afterAll(async () => stop())

    it('rejects wrong credentials with a useful message', async () => {
      const bad = new S3Client(client.settings, { accessKeyId: 'nope', secretAccessKey: 'nope' })
      await expect(bad.checkBucket()).rejects.toThrow(/S3 \w+/)
    })

    it('browses: mkdir, files, list, stat, read, rename, delete', async () => {
      const root = fresh()
      const b = new S3Browser(client)
      if (backend.markers) await b.mkdir(`${root}/docs`)
      await b.createFile(`${root}/docs/empty.txt`)
      await expect(b.createFile(`${root}/docs/empty.txt`)).rejects.toThrow(/already exists/)
      await client.put(`${keyOf(root)}/readme.md`, Buffer.from('# hello world\n'))
      const listing = (await b.list(root)).map((e) => `${e.type}:${e.name}`).sort()
      expect(listing).toEqual(['directory:docs', 'file:readme.md'])
      expect((await b.stat(`${root}/readme.md`)).size).toBe(14)
      expect((await b.stat(`${root}/docs`)).type).toBe('directory')
      await expect(b.stat(`${root}/missing`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await b.readHead(`${root}/readme.md`, 7)).toEqual({ bytes: Buffer.from('# hello'), size: 14 })
      expect((await b.readHead(`${root}/docs/empty.txt`, 10)).size).toBe(0)
      await b.rename(`${root}/readme.md`, `${root}/docs/README.md`)
      await b.rename(`${root}/docs`, `${root}/papers`)
      expect((await b.list(`${root}/papers`)).map((e) => e.name).sort()).toEqual(['README.md', 'empty.txt'])
      await expect(b.rmdir(`${root}/papers`)).rejects.toThrow(/not empty/)
      await b.removeRecursive(`${root}/papers`)
      expect(await b.list(root)).toEqual([])
    })

    it('uploads a folder, skips unchanged, updates changed, and keeps mtimes', async () => {
      const remote = fresh()
      const src = temp('up')
      mkdirSync(join(src, 'sub'))
      writeFileSync(join(src, 'a.txt'), 'alpha')
      writeFileSync(join(src, 'sub', 'b.txt'), 'bravo')
      writeFileSync(join(src, 'skip.log'), 'noise')
      const old = new Date('2020-01-02T03:04:05Z')
      utimesSync(join(src, 'a.txt'), old, old)
      const spec: S3SyncSpec = { direction: 'upload', client, local: `${src}/`, remote: `${remote}/`, options: { excludes: ['*.log'] } }

      const first = await collect(spec)
      expect(exitOf(first).code).toBe(0)
      expect(changes(first)).toEqual(['add a.txt', 'add sub/b.txt'])
      expect((await client.head(`${keyOf(remote)}/a.txt`))?.mtimeMs).toBe(old.getTime())

      const second = await collect(spec)
      expect(changes(second)).toEqual([])
      expect(second.find((e) => e.type === 'stats')).toMatchObject({ stats: { filesTransferred: 0 } })

      writeFileSync(join(src, 'a.txt'), 'ALPHA!')
      expect(changes(await collect(spec))).toEqual(['update a.txt'])
    })

    it('copies a folder itself without a trailing slash, and a single file into a prefix or to a name', async () => {
      const remote = fresh()
      const src = temp('shape')
      mkdirSync(join(src, 'site'))
      writeFileSync(join(src, 'site', 'index.html'), '<h1>')
      writeFileSync(join(src, 'one.txt'), '1')
      await collect({ direction: 'upload', client, local: join(src, 'site'), remote: `${remote}/`, options: {} })
      await collect({ direction: 'upload', client, local: join(src, 'one.txt'), remote: `${remote}/files/`, options: {} })
      await collect({ direction: 'upload', client, local: join(src, 'one.txt'), remote: `${remote}/renamed.txt`, options: {} })
      const b = new S3Browser(client)
      expect((await b.list(remote)).map((e) => e.name).sort()).toEqual(['files', 'renamed.txt', 'site'])
      expect((await b.list(`${remote}/site`)).map((e) => e.name)).toEqual(['index.html'])
      expect((await b.list(`${remote}/files`)).map((e) => e.name)).toEqual(['one.txt'])
    })

    it('mirrors deletes only when confirmed, and never deletes excluded paths', async () => {
      const remote = fresh()
      const src = temp('mirror')
      writeFileSync(join(src, 'keep.txt'), 'k')
      await client.put(`${keyOf(remote)}/stale.txt`, Buffer.from('s'))
      await client.put(`${keyOf(remote)}/old/deep.txt`, Buffer.from('d'))
      await client.put(`${keyOf(remote)}/private.secret`, Buffer.from('p'))
      const spec: S3SyncSpec = { direction: 'upload', client, local: `${src}/`, remote: `${remote}/`, options: { deleteMode: 'after', excludes: ['*.secret'] } }

      const refused = await collect(spec)
      expect(exitOf(refused).code).toBe(1)
      expect(exitOf(refused).message).toMatch(/confirm the delete list/)

      const preview = await collect({ ...spec, options: { ...spec.options, dryRun: true } })
      expect(changes(preview)).toEqual(['add keep.txt', 'delete old/', 'delete old/deep.txt', 'delete stale.txt'])
      expect(await client.head(`${keyOf(remote)}/stale.txt`)).not.toBeNull()

      expect(exitOf(await collect({ ...spec, deletesConfirmed: true })).code).toBe(0)
      expect((await new S3Browser(client).list(remote)).map((e) => e.name).sort()).toEqual(['keep.txt', 'private.secret'])
    })

    it('downloads with timestamps, then finds nothing to do', async () => {
      const remote = fresh()
      const src = temp('rt-src')
      writeFileSync(join(src, 'photo.jpg'), Buffer.alloc(3000, 7))
      mkdirSync(join(src, 'nested'))
      writeFileSync(join(src, 'nested', 'n.txt'), 'nested')
      const when = new Date('2021-06-07T08:09:10Z')
      utimesSync(join(src, 'photo.jpg'), when, when)
      await collect({ direction: 'upload', client, local: `${src}/`, remote: `${remote}/`, options: {} })

      const dest = temp('rt-dst')
      const down = await collect({ direction: 'download', client, local: `${dest}/`, remote: `${remote}/`, options: {} })
      expect(exitOf(down).code).toBe(0)
      expect(readFileSync(join(dest, 'photo.jpg'))).toEqual(Buffer.alloc(3000, 7))
      expect(readFileSync(join(dest, 'nested', 'n.txt'), 'utf8')).toBe('nested')
      expect(statSync(join(dest, 'photo.jpg')).mtime.getTime()).toBe(when.getTime())
      expect(readdirSync(dest).some((f) => f.includes('partial'))).toBe(false)

      expect(changes(await collect({ direction: 'download', client, local: `${dest}/`, remote: `${remote}/`, options: {} }))).toEqual([])
      // And the copy goes back up as unchanged.
      expect(changes(await collect({ direction: 'upload', client, local: `${dest}/`, remote: `${remote}/`, options: {} }))).toEqual([])
    })

    it('uploads and downloads a multipart object intact', async () => {
      const remote = fresh()
      const src = temp('big')
      const big = Buffer.alloc(17 * 1024 * 1024)
      for (let i = 0; i < big.length; i += 4096) big[i] = i % 251
      writeFileSync(join(src, 'big.bin'), big)
      const up = await collect({ direction: 'upload', client, local: join(src, 'big.bin'), remote: `${remote}/`, options: {} })
      expect(exitOf(up).code).toBe(0)
      expect((await client.head(`${keyOf(remote)}/big.bin`))?.size).toBe(big.length)
      const dest = temp('big-dst')
      await collect({ direction: 'download', client, local: `${dest}/`, remote: `${remote}/big.bin`, options: {} })
      expect(readFileSync(join(dest, 'big.bin')).equals(big)).toBe(true)
    }, 60_000)

    it('detects same-size changes with checksum', async () => {
      const remote = fresh()
      const src = temp('sum')
      writeFileSync(join(src, 'x.txt'), 'aaaa')
      const spec: S3SyncSpec = { direction: 'upload', client, local: `${src}/`, remote: `${remote}/`, options: { checksum: true } }
      await collect(spec)
      const later = statSync(join(src, 'x.txt')).mtime
      writeFileSync(join(src, 'x.txt'), 'bbbb')
      utimesSync(join(src, 'x.txt'), later, later)
      expect(changes(await collect(spec))).toEqual(['update x.txt'])
      expect(changes(await collect(spec))).toEqual([])
    })

    it('stops on cancel with a resumable exit', async () => {
      const remote = fresh()
      const src = temp('cancel')
      for (let i = 0; i < 40; i++) writeFileSync(join(src, `f${i}.txt`), `file ${i}`)
      const handle = runS3Sync({ direction: 'upload', client, local: `${src}/`, remote: `${remote}/`, options: {}, concurrency: 1 })
      const events: RsyncEvent[] = []
      for await (const event of handle.events) {
        events.push(event)
        if (event.type === 'file') handle.cancel()
      }
      expect(exitOf(events)).toMatchObject({ code: 20, resumable: true })
    })
  })
}
