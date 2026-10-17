import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '@diskpush/schemas'

/**
 * A remote ref names a connection, not a kind. These check that a ref to a
 * saved S3 connection becomes an S3 endpoint with a client, and that nothing
 * SSH-shaped (a shell, a cached rsync capability) leaks into its plan.
 */

const S3_CONN: Connection = {
  id: 'bucket-1',
  kind: 's3',
  s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-backups', pathStyle: null, accessKeyId: 'AKID' },
  name: 'backups',
  host: 'acct.r2.cloudflarestorage.com',
  port: 443,
  username: 'my-backups',
  authType: 'agent',
  keyPath: null,
  defaultLocalPath: null,
  defaultRemotePath: null,
  jumpHost: null,
  rsyncPath: null,
  connectTimeoutSeconds: 15,
  keepaliveSeconds: 30,
  forwardAgent: false,
  tags: [],
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const SSH_CONN: Connection = { ...S3_CONN, id: 'server-1', kind: 'ssh', s3: null, name: 'web', host: 'web.example.com', port: 22, username: 'deploy' }

const settingsRead: string[] = []

vi.mock('./store.js', () => ({
  store: async () => ({
    findConnection: async (id: string) => [S3_CONN, SSH_CONN].find((c) => c.id === id) ?? null,
    getSetting: async <T>(key: string, fallback: T) => {
      settingsRead.push(key)
      return fallback
    },
    getConnectionSecret: async (id: string, name: string) => (id === 'bucket-1' && name === 's3SecretAccessKey' ? 'SECRET' : null),
  }),
}))

type PlanInput = { source: { type: string }; destination: { type: string }; s3Client?: unknown; remoteShell?: unknown; sourceShell?: unknown }
const planned: PlanInput[] = []

vi.mock('@diskpush/rsync-core', () => ({
  planTransfer: (input: PlanInput) => {
    planned.push(input)
    return { binary: 's3', args: [], display: 'diskpush s3 sync', warnings: [], engine: 's3' }
  },
  runPlan: () => ({
    cancel: () => {},
    events: (async function* () {
      yield { type: 'change', change: { action: 'add', path: 'a.txt', itemized: '' } }
      yield { type: 'exit', code: 0, signal: null, resumable: false, message: 'Done.' }
    })(),
  }),
  parseRsyncCapabilities: () => ({}),
  intersectCapabilities: (a: unknown) => a,
  unknownCapabilities: () => ({}),
}))

const { resolveEndpoint, previewTransfer } = await import('./transfers.js')
const { bucketPath } = await import('./s3.js')

const OPTIONS = {
  archive: true,
  checksum: false,
  compression: 'auto' as const,
  deleteMode: 'off' as const,
  hardLinks: false,
  acls: false,
  xattrs: false,
  numericIds: false,
  update: false,
  ignoreExisting: false,
  existingOnly: false,
  inplace: false,
  excludes: [],
  includes: [],
  bwlimit: null,
  maxSize: null,
  minSize: null,
}

const sender = () => ({ isDestroyed: () => false, send: () => {} }) as never

describe('resolveEndpoint for an S3 connection', () => {
  it('builds an s3 endpoint from the saved bucket, with a client', async () => {
    const resolved = await resolveEndpoint({ type: 'ssh', connectionId: 'bucket-1', path: '/photos/' })
    expect(resolved.endpoint).toEqual({ type: 's3', connectionId: 'bucket-1', name: 'backups', bucket: 'my-backups', path: '/photos/' })
    expect(resolved.connectionId).toBe('bucket-1')
    expect(resolved.s3Client).toBeDefined()
  })

  it('maps the pane’s `.` to the bucket root', async () => {
    const resolved = await resolveEndpoint({ type: 'ssh', connectionId: 'bucket-1', path: '.' })
    expect(resolved.endpoint).toMatchObject({ type: 's3', path: '/' })
  })

  it('still builds an ssh endpoint for a server', async () => {
    const resolved = await resolveEndpoint({ type: 'ssh', connectionId: 'server-1', path: '/srv/' })
    expect(resolved.endpoint).toMatchObject({ type: 'ssh', host: 'web.example.com', user: 'deploy' })
    expect(resolved.s3Client).toBeUndefined()
  })
})

describe('a local <-> S3 plan', () => {
  it('passes the S3 client, no remote shell, and asks no cached rsync capabilities of the bucket', async () => {
    planned.length = 0
    settingsRead.length = 0
    const result = await previewTransfer(
      {
        source: { type: 'local', path: '/home/me/photos/' },
        destination: { type: 'ssh', connectionId: 'bucket-1', path: '/photos/' },
        options: OPTIONS,
        deletesConfirmed: false,
        selection: [],
        previewId: 'p1',
      },
      sender(),
    )

    const input = planned.at(-1)!
    expect(input.destination.type).toBe('s3')
    expect(input.s3Client).toBeDefined()
    expect(input.remoteShell).toBeUndefined()
    expect(input.sourceShell).toBeUndefined()
    expect(settingsRead).not.toContain('capabilities:bucket-1')
    // The S3 engine's events count the same way rsync's do.
    expect(result.changeTotal).toBe(1)
    expect(result.ok).toBe(true)
  })
})

describe('bucketPath', () => {
  it('roots relative and dot paths, and keeps a trailing slash', () => {
    expect(bucketPath('.')).toBe('/')
    expect(bucketPath('')).toBe('/')
    expect(bucketPath('./a/b/')).toBe('/a/b/')
    expect(bucketPath('a')).toBe('/a')
    expect(bucketPath('/a/b/')).toBe('/a/b/')
  })
})
