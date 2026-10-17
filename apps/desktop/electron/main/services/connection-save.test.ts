import { ConnectionSchema, type Connection } from '@diskpush/schemas'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionInputSchema } from '../../shared/contract.js'

/**
 * What connections:save does with an S3 connection: derive the display
 * fields, keep the secret write-only, and never hand it back.
 */

const rows = new Map<string, Connection>()
const secrets = new Map<string, string>()

vi.mock('./store.js', () => ({
  store: async () => ({
    findConnection: async (id: string) => rows.get(id) ?? null,
    saveConnection: async (input: Omit<Connection, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => {
      const id = input.id ?? `id-${rows.size + 1}`
      const row = ConnectionSchema.parse({ ...input, id, createdAt: 'now', updatedAt: 'now' })
      rows.set(id, row)
      return row
    },
    getConnectionSecret: async (id: string, name: string) => secrets.get(`${id}:${name}`) ?? null,
    setConnectionSecret: async (id: string, name: string, value: string | null) => {
      if (value === null) secrets.delete(`${id}:${name}`)
      else secrets.set(`${id}:${name}`, value)
    },
  }),
}))

const { saveConnectionInput, forRenderer } = await import('./connections.js')

const save = (raw: unknown) => saveConnectionInput(ConnectionInputSchema.parse(raw))

beforeEach(() => {
  rows.clear()
  secrets.clear()
})

describe('saving an S3 connection', () => {
  const r2 = {
    kind: 's3',
    name: 'backups',
    s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-backups', accessKeyId: 'AKID' },
  }

  it('derives host, username and port so labels read bucket@host', async () => {
    const saved = await save(r2)
    expect(saved).toMatchObject({ kind: 's3', host: 'acct.r2.cloudflarestorage.com', username: 'my-backups', port: 443 })
    expect(saved.s3?.bucket).toBe('my-backups')
  })

  it('stores the secret but never returns it, only hasSecret', async () => {
    const saved = await save({ ...r2, s3SecretAccessKey: 'TOPSECRET' })
    expect(secrets.get(`${saved.id}:s3SecretAccessKey`)).toBe('TOPSECRET')
    expect(saved.hasSecret).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('TOPSECRET')
    expect(JSON.stringify(rows.get(saved.id))).not.toContain('TOPSECRET')
  })

  it('keeps the stored secret when the field is left empty, and clears it on null', async () => {
    const first = await save({ ...r2, s3SecretAccessKey: 'TOPSECRET' })
    const kept = await save({ ...r2, id: first.id, s3SecretAccessKey: '' })
    expect(kept.hasSecret).toBe(true)
    const keptAgain = await save({ ...r2, id: first.id })
    expect(keptAgain.hasSecret).toBe(true)
    const cleared = await save({ ...r2, id: first.id, s3SecretAccessKey: null })
    expect(cleared.hasSecret).toBe(false)
    expect(secrets.size).toBe(0)
  })

  it('drops the S3 secret when a connection is switched back to SSH', async () => {
    const first = await save({ ...r2, s3SecretAccessKey: 'TOPSECRET' })
    const server = await save({ id: first.id, name: 'backups', host: 'web.example.com', username: 'deploy' })
    expect(server).toMatchObject({ kind: 'ssh', s3: null, host: 'web.example.com' })
    expect(server.hasSecret).toBeUndefined()
    expect(secrets.size).toBe(0)
  })

  it('uses the AWS endpoint for its host when none is given', async () => {
    const saved = await save({ kind: 's3', name: 'aws', s3: { bucket: 'b', region: 'eu-west-2' } })
    expect(saved.host).toContain('eu-west-2')
    expect(saved.username).toBe('b')
  })
})

describe('forRenderer', () => {
  it('leaves an SSH connection as it is', async () => {
    const server = await save({ name: 'web', host: 'h', username: 'u' })
    expect(await forRenderer(server)).toEqual(server)
  })
})
