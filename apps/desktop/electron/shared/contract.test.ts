import { describe, expect, it } from 'vitest'
import {
  ConnectionInputSchema,
  EndpointRefSchema,
  ExternalUrlSchema,
  PathSchema,
  TransferOptionsSchema,
  TransferRequestSchema,
} from './contract.js'

/**
 * The IPC boundary is where a compromised renderer would try to reach the
 * main process. These assert what it cannot express.
 */

describe('EndpointRefSchema', () => {
  it('accepts a local path', () => {
    expect(EndpointRefSchema.parse({ type: 'local', path: '/srv/app' })).toEqual({ type: 'local', path: '/srv/app' })
  })

  it('names a remote endpoint by saved connection id, never by host', () => {
    const parsed = EndpointRefSchema.parse({ type: 'ssh', connectionId: 'abc', path: '/srv' })
    expect(parsed).toEqual({ type: 'ssh', connectionId: 'abc', path: '/srv' })
    // There is no field here for a host, user, port or key: those come from
    // the stored connection, so the renderer cannot invent a host to reach.
    expect(Object.keys(parsed)).toEqual(['type', 'connectionId', 'path'])
  })

  it('rejects an endpoint that supplies its own host', () => {
    const parsed = EndpointRefSchema.parse({
      type: 'ssh',
      connectionId: 'abc',
      path: '/srv',
      host: 'evil.example.com',
    } as never)
    expect('host' in parsed).toBe(false)
  })

  it('rejects an unknown endpoint type', () => {
    expect(() => EndpointRefSchema.parse({ type: 'rsync-daemon', path: '/x' })).toThrow()
  })

  it('rejects an empty path', () => {
    expect(() => PathSchema.parse('')).toThrow()
  })

  it('caps path length', () => {
    expect(() => PathSchema.parse('a'.repeat(5000))).toThrow()
  })
})

describe('TransferOptionsSchema', () => {
  it('has no field for raw rsync arguments', () => {
    const parsed = TransferOptionsSchema.parse({})
    expect('rawArgs' in parsed).toBe(false)
  })

  it('drops raw rsync arguments if they are sent anyway', () => {
    const parsed = TransferOptionsSchema.parse({ rawArgs: ['--delete', '--remove-source-files'] } as never)
    expect('rawArgs' in parsed).toBe(false)
  })

  it('has no field for a remote shell or an rsync binary path', () => {
    const parsed = TransferOptionsSchema.parse({ rsyncPath: '/tmp/evil', rsh: 'sh -c id' } as never)
    expect('rsyncPath' in parsed).toBe(false)
    expect('rsh' in parsed).toBe(false)
  })

  it('only allows the two delete modes the UI offers', () => {
    expect(TransferOptionsSchema.parse({ deleteMode: 'delay' }).deleteMode).toBe('delay')
    expect(() => TransferOptionsSchema.parse({ deleteMode: 'during' })).toThrow()
  })

  it('defaults to non-destructive', () => {
    expect(TransferOptionsSchema.parse({}).deleteMode).toBe('off')
  })

  it('constrains bwlimit to a rate, not an arbitrary string', () => {
    expect(TransferOptionsSchema.parse({ bwlimit: '50M' }).bwlimit).toBe('50M')
    expect(() => TransferOptionsSchema.parse({ bwlimit: '50M --delete' })).toThrow()
    expect(() => TransferOptionsSchema.parse({ bwlimit: '$(id)' })).toThrow()
  })

  it('constrains size filters the same way', () => {
    expect(TransferOptionsSchema.parse({ maxSize: '2G' }).maxSize).toBe('2G')
    expect(() => TransferOptionsSchema.parse({ maxSize: '; rm -rf /' })).toThrow()
  })

  it('caps the number of exclude patterns', () => {
    expect(() => TransferOptionsSchema.parse({ excludes: Array.from({ length: 501 }, () => 'x') })).toThrow()
  })
})

describe('TransferRequestSchema', () => {
  it('defaults deletesConfirmed to false', () => {
    const parsed = TransferRequestSchema.parse({
      source: { type: 'local', path: '/a' },
      destination: { type: 'local', path: '/b' },
      options: {},
    })
    expect(parsed.deletesConfirmed).toBe(false)
  })
})

describe('ExternalUrlSchema', () => {
  it('allows http and https', () => {
    expect(ExternalUrlSchema.parse('https://diskpush.com')).toBe('https://diskpush.com')
  })

  it('refuses every other scheme', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>']) {
      expect(() => ExternalUrlSchema.parse(url)).toThrow()
    }
  })
})

describe('ConnectionInputSchema', () => {
  it('rejects an out-of-range port', () => {
    const base = { name: 'x', host: 'h', username: 'u' }
    expect(() => ConnectionInputSchema.parse({ ...base, port: 0 })).toThrow()
    expect(() => ConnectionInputSchema.parse({ ...base, port: 70000 })).toThrow()
  })

  it('has no field for a password or a passphrase', () => {
    const parsed = ConnectionInputSchema.parse({
      name: 'x',
      host: 'h',
      username: 'u',
      password: 'hunter2',
      passphrase: 'hunter2',
    } as never)
    expect('password' in parsed).toBe(false)
    expect('passphrase' in parsed).toBe(false)
  })

  it('defaults to agent authentication, which stores no secret', () => {
    expect(ConnectionInputSchema.parse({ name: 'x', host: 'h', username: 'u' }).authType).toBe('agent')
  })

  it('defaults agent forwarding to off', () => {
    expect(ConnectionInputSchema.parse({ name: 'x', host: 'h', username: 'u' }).forwardAgent).toBe(false)
  })
})
