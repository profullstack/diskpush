/**
 * A pane on an S3 bucket: what it hands the transfer engine, and what it
 * refuses to do (there is no shell to edit in, and nothing local to open).
 */
import { describe, expect, it } from 'vitest'
import type { Connection } from '@diskpush/schemas'
import { blankPane, buildEndpointChoices, endpointString, scopeTransfer, type Entry } from './model.js'
import { editLaunch, openLaunch } from './launch.js'

const bucket = {
  id: 'b1',
  name: 'backups',
  kind: 's3',
  s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'site-backups', pathStyle: null, accessKeyId: 'AKID' },
  host: 'acct.r2.cloudflarestorage.com',
  username: 'site-backups',
  port: 443,
  defaultRemotePath: null,
} as unknown as Connection

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({ name, isDirectory: false, size: 0, modifiedAt: null, ...over })

describe('S3 panes', () => {
  it('address the bucket as s3://, which the planner sends to the S3 engine', () => {
    const pane = blankPane('backups', '/db', bucket)
    expect(endpointString(pane)).toBe('s3://site-backups/db/')
    expect(endpointString(pane, 'dump.sql.gz', false)).toBe('s3://site-backups/db/dump.sql.gz')
  })

  it('scope a local selection into the bucket at the same relative path', () => {
    const local = blankPane('Local', '/home/me/site')
    local.entries = [entry('public', { isDirectory: true })]
    local.index = 0
    expect(scopeTransfer(local, blankPane('backups', '/', bucket))).toEqual({ from: '/home/me/site/public/', to: 's3://site-backups/public/', what: 'public' })
  })

  it('start at the bucket root and show the bucket in the picker', () => {
    const [, choice] = buildEndpointChoices([bucket], [], '/home/me')
    expect(choice).toMatchObject({ label: 'backups', path: '/', detail: 's3://site-backups  (acct.r2.cloudflarestorage.com)' })
  })

  it('refuse edit and open with what to do instead', () => {
    const target = { path: '/db/a.sql', name: 'a.sql', connection: bucket }
    expect(editLaunch(target, {}, () => true)).toEqual({ error: expect.stringMatching(/in a bucket/) })
    expect(openLaunch(target, {}, () => true)).toEqual({ error: expect.stringMatching(/Sync a\.sql here first\.$/) })
  })
})
