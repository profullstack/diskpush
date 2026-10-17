import { describe, expect, it } from 'vitest'
import type { Connection } from '@/lib/api'
import {
  applyPreset,
  BLANK_S3,
  connectionDetail,
  defaultRemotePathOf,
  endpointHint,
  fieldIssue,
  providerOf,
  s3SyncCommand,
  s3Url,
  s3DraftFrom,
  s3Payload,
  s3Problem,
} from './s3-form.js'

const bucket = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'b1',
  kind: 's3',
  s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-backups', pathStyle: null, accessKeyId: 'AKID' },
  hasSecret: true,
  name: 'backups',
  host: 'acct.r2.cloudflarestorage.com',
  port: 443,
  username: 'my-backups',
  authType: 'agent',
  defaultRemotePath: null,
  defaultLocalPath: null,
  ...overrides,
})

describe('the S3 form', () => {
  it('pre-fills the provider’s endpoint pattern and region', () => {
    expect(applyPreset(BLANK_S3, 'r2')).toMatchObject({ endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', region: 'auto' })
    expect(applyPreset(BLANK_S3, 'aws')).toMatchObject({ endpoint: '', region: 'us-east-1' })
  })

  it('will not save until the <…> placeholder is replaced', () => {
    const draft = { ...applyPreset(BLANK_S3, 'r2'), bucket: 'b' }
    expect(s3Problem(draft)).toMatch(/Replace/)
    expect(s3Problem({ ...draft, endpoint: 'https://abc.r2.cloudflarestorage.com' })).toBeNull()
  })

  it('needs a bucket and a region, and an endpoint off AWS', () => {
    expect(s3Problem(BLANK_S3)).toMatch(/bucket/)
    expect(s3Problem({ ...BLANK_S3, bucket: 'b', region: '' })).toMatch(/region/)
    expect(s3Problem({ ...BLANK_S3, bucket: 'b' })).toBeNull()
    expect(s3Problem({ ...BLANK_S3, bucket: 'b', provider: 'other' })).toMatch(/endpoint/)
  })

  it('round-trips a saved connection, starting the secret empty', () => {
    const draft = s3DraftFrom(bucket())
    expect(draft).toMatchObject({ provider: 'r2', bucket: 'my-backups', secret: '', hasSecret: true, pathStyle: 'auto' })
    expect(s3Payload(draft)).toEqual({
      s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-backups', pathStyle: null, accessKeyId: 'AKID' },
    })
  })

  it('sends the secret only when typed, and null only when clearing', () => {
    const draft = s3DraftFrom(bucket())
    expect('s3SecretAccessKey' in s3Payload(draft)).toBe(false)
    expect(s3Payload({ ...draft, secret: ' new ' }).s3SecretAccessKey).toBe('new')
    expect(s3Payload({ ...draft, clearSecret: true }).s3SecretAccessKey).toBeNull()
  })

  it('maps the path-style choice to the tri-state setting', () => {
    expect(s3Payload({ ...BLANK_S3, bucket: 'b', pathStyle: 'on' }).s3.pathStyle).toBe(true)
    expect(s3Payload({ ...BLANK_S3, bucket: 'b', pathStyle: 'off' }).s3.pathStyle).toBe(false)
  })

  it('recognises providers from a saved endpoint', () => {
    expect(providerOf(null)).toBe('aws')
    expect(providerOf('https://s3.us-west-004.backblazeb2.com')).toBe('b2')
    expect(providerOf('http://localhost:9000')).toBe('other')
  })
})

describe('endpoint hint and inline issues', () => {
  it('asks to replace the placeholder only while it is there', () => {
    const preset = applyPreset(BLANK_S3, 'r2')
    expect(endpointHint(preset)).toMatch(/Replace <ACCOUNT_ID>/)
    expect(endpointHint({ ...preset, endpoint: 'https://abc.r2.cloudflarestorage.com' })).not.toMatch(/Replace/)
    expect(endpointHint(s3DraftFrom(bucket()))).not.toMatch(/Replace/)
  })

  it('ties the placeholder problem to the endpoint field, even before a bucket is typed', () => {
    const preset = applyPreset(BLANK_S3, 'r2')
    expect(fieldIssue(preset, 'endpoint')).toMatch(/Replace/)
    // An empty bucket is not flagged inline; the empty box says it.
    expect(fieldIssue(preset, 'bucket')).toBeNull()
    expect(fieldIssue({ ...preset, bucket: 'a b' }, 'bucket')).toMatch(/letters/)
    expect(fieldIssue({ ...preset, endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'b' }, 'endpoint')).toBeNull()
  })

  it('describes an S3 sync the way the main process plan does', () => {
    expect(s3SyncCommand('/home/me/x/', s3Url('b', '/p/'), false)).toBe('diskpush s3 sync /home/me/x/ s3://b/p/')
    expect(s3SyncCommand(s3Url('b', '/'), '/tmp/', true)).toBe('diskpush s3 sync --delete s3://b/ /tmp/')
  })
})

describe('labels and paths', () => {
  it('shows s3://bucket for a bucket and user@host for a server', () => {
    expect(connectionDetail(bucket())).toBe('s3://my-backups')
    expect(connectionDetail(bucket({ kind: 'ssh', s3: null, username: 'deploy', host: 'h', port: 22 }))).toBe('deploy@h')
  })

  it('opens a bucket at its root, a server at its login directory', () => {
    expect(defaultRemotePathOf(bucket())).toBe('/')
    expect(defaultRemotePathOf(bucket({ defaultRemotePath: '/photos/' }))).toBe('/photos/')
    expect(defaultRemotePathOf(bucket({ kind: 'ssh', s3: null }))).toBe('.')
  })
})
