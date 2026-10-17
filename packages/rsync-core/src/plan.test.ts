import { defaultRsyncOptions } from '@diskpush/schemas'
import { describe, expect, it } from 'vitest'
import { parseEndpoint } from './endpoint.js'
import { planTransfer } from './plan.js'
import { S3Client } from '@diskpush/s3-core'
import { parseRsyncCapabilities } from './version.js'

const MODERN = parseRsyncCapabilities(`rsync  version 3.4.1  protocol version 32
Compress list: zstd zlib none`)

describe('planTransfer: local to remote', () => {
  it('spawns rsync directly', () => {
    const plan = planTransfer({
      source: parseEndpoint('./dist/'),
      destination: parseEndpoint('prod:/srv/app/'),
      options: defaultRsyncOptions(),
      capabilities: MODERN,
    })
    expect(plan.binary).toBe('rsync')
    expect(plan.topology).toBe('local-to-remote')
    expect(plan.args.at(-2)).toBe('./dist/')
    expect(plan.args.at(-1)).toBe('prod:/srv/app/')
  })

  it('carries the connection port into the SSH transport, not the path', () => {
    const plan = planTransfer({
      source: parseEndpoint('./dist/'),
      destination: { ...parseEndpoint('prod:/srv/app/'), port: 2222 } as never,
      options: defaultRsyncOptions(),
      capabilities: MODERN,
    })
    const rsh = plan.args[plan.args.indexOf('--rsh') + 1]!
    expect(rsh).toContain('-p 2222')
    expect(plan.args.at(-1)).toBe('prod:/srv/app/')
  })

  it('always verifies host keys', () => {
    const plan = planTransfer({
      source: parseEndpoint('./dist/'),
      destination: parseEndpoint('prod:/srv/app/'),
      options: defaultRsyncOptions(),
      capabilities: MODERN,
    })
    const rsh = plan.args[plan.args.indexOf('--rsh') + 1]!
    expect(rsh).toContain('StrictHostKeyChecking=accept-new')
    expect(rsh).not.toContain('StrictHostKeyChecking=no')
  })
})

describe('planTransfer: server to server', () => {
  const plan = () =>
    planTransfer({
      source: parseEndpoint('media-01:/srv/media/'),
      destination: parseEndpoint('backup-02:/data/media/'),
      options: defaultRsyncOptions(),
      capabilities: MODERN,
    })

  it('runs rsync on the source host over an SSH control session', () => {
    const p = plan()
    expect(p.binary).toBe('ssh')
    expect(p.topology).toBe('remote-to-remote')
    expect(p.args.at(-2)).toBe('media-01')
  })

  it('passes the whole remote rsync command as one argv element', () => {
    const p = plan()
    const remoteCommand = p.args.at(-1)!
    expect(remoteCommand.startsWith('rsync ')).toBe(true)
    // One element, not many: ssh joins argv with spaces before the remote shell sees it.
    expect(p.args.filter((a) => a.includes('rsync')).length).toBe(1)
  })

  it('sends the source path as a local path on the source host', () => {
    const remoteCommand = plan().args.at(-1)!
    expect(remoteCommand).toContain(' /srv/media/ backup-02:/data/media/')
    expect(remoteCommand).not.toContain('media-01:/srv/media/')
  })

  it('reports the payload path as direct', () => {
    expect(plan().direct).toBe(true)
  })

  it('shows the control session separately from the rsync command', () => {
    const p = plan()
    expect(p.controlDisplay).toContain('media-01')
    expect(p.display.startsWith('rsync')).toBe(true)
  })

  it('quotes a hostile source path so the remote shell cannot execute it', () => {
    const p = planTransfer({
      source: parseEndpoint('media-01:/srv/$(touch /tmp/pwned)/media/'),
      destination: parseEndpoint('backup-02:/data/media/'),
      options: defaultRsyncOptions(),
      capabilities: MODERN,
    })
    const remoteCommand = p.args.at(-1)!
    expect(remoteCommand).toContain(`'/srv/$(touch /tmp/pwned)/media/'`)
    expect(remoteCommand).not.toMatch(/(^|\s)\/srv\/\$\(/)
  })

  it('quotes a path containing a single quote without breaking out', () => {
    const p = planTransfer({
      source: parseEndpoint("media-01:/srv/it's here/"),
      destination: parseEndpoint('backup-02:/data/media/'),
      options: defaultRsyncOptions(),
      capabilities: MODERN,
    })
    expect(p.args.at(-1)).toContain(`'/srv/it'\\''s here/'`)
  })

  it('honours a source-host rsync path override', () => {
    const p = planTransfer({
      source: parseEndpoint('media-01:/srv/media/'),
      destination: parseEndpoint('backup-02:/data/media/'),
      options: defaultRsyncOptions(),
      capabilities: MODERN,
      sourceRsyncPath: '/opt/homebrew/bin/rsync',
    })
    expect(p.args.at(-1)!.startsWith('/opt/homebrew/bin/rsync ')).toBe(true)
  })

  it('applies mirror confirmation on the server-to-server path too', () => {
    expect(() =>
      planTransfer({
        source: parseEndpoint('media-01:/srv/media/'),
        destination: parseEndpoint('backup-02:/data/media/'),
        options: defaultRsyncOptions({ deleteMode: 'delay' }),
        capabilities: MODERN,
      }),
    ).toThrow(/confirm the delete list/i)
  })
})

describe('planTransfer: S3', () => {
  const client = new S3Client({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', bucket: 'b', pathStyle: true }, { accessKeyId: 'a', secretAccessKey: 's' })
  const bucket = { type: 's3' as const, name: 'b', bucket: 'b', path: '/backups/' }

  it('runs local -> bucket on the S3 engine, not rsync', () => {
    const plan = planTransfer({ source: parseEndpoint('./site/'), destination: bucket, options: defaultRsyncOptions(), s3Client: client })
    expect(plan.engine).toBe('s3')
    expect(plan.s3).toMatchObject({ direction: 'upload', local: './site/', remote: '/backups/' })
    expect(plan.display).toBe('diskpush s3 sync ./site/ s3://b/backups/')
  })

  it('refuses server <-> bucket, a mirror without a confirmed preview, and a missing client', () => {
    expect(() => planTransfer({ source: parseEndpoint('prod:/srv/'), destination: bucket, options: defaultRsyncOptions(), s3Client: client })).toThrow(/between this machine and a bucket/)
    expect(() => planTransfer({ source: parseEndpoint('./a/'), destination: bucket, options: defaultRsyncOptions({ deleteMode: 'after' }), s3Client: client })).toThrow(/confirm the delete list/)
    expect(() => planTransfer({ source: bucket, destination: parseEndpoint('./a/'), options: defaultRsyncOptions() })).toThrow(/no S3 client/)
  })

  it('says which rsync-only options it cannot honour', () => {
    const plan = planTransfer({ source: parseEndpoint('./a/'), destination: bucket, options: defaultRsyncOptions({ acls: true, rawArgs: ['--foo'] }), s3Client: client })
    expect(plan.warnings).toHaveLength(2)
  })
})
