import { DiskPushStore } from '@diskpush/database'
import { describe, expect, it } from 'vitest'
import { parseArgv } from './parse-argv.js'
import { optionsFromFlags, resolveEndpoint } from './resolve.js'

const connection = {
  name: 'production',
  host: '203.0.113.10',
  port: 2222,
  username: 'deploy',
  authType: 'key' as const,
  keyPath: '/home/anthony/.ssh/id_prod',
  defaultLocalPath: null,
  defaultRemotePath: '/srv/app',
  jumpHost: 'bastion',
  rsyncPath: null,
  connectTimeoutSeconds: 15,
  keepaliveSeconds: 30,
  forwardAgent: false,
  tags: [],
  notes: '',
}

describe('resolveEndpoint', () => {
  it('fills in the host, user and port from a saved connection', async () => {
    const store = await DiskPushStore.open({ path: ':memory:' })
    await store.saveConnection(connection)

    const resolved = await resolveEndpoint(store, 'production:/srv/app/')
    expect(resolved.endpoint).toMatchObject({
      type: 'ssh',
      host: '203.0.113.10',
      user: 'deploy',
      port: 2222,
      path: '/srv/app/',
    })
    expect(resolved.connection?.name).toBe('production')
    await store.close()
  })

  it('lets an explicit user on the command line win over the saved one', async () => {
    const store = await DiskPushStore.open({ path: ':memory:' })
    await store.saveConnection(connection)
    const resolved = await resolveEndpoint(store, 'root@production:/srv/')
    expect(resolved.endpoint).toMatchObject({ user: 'root' })
    await store.close()
  })

  it('passes an unknown host through as a plain SSH endpoint', async () => {
    const store = await DiskPushStore.open({ path: ':memory:' })
    const resolved = await resolveEndpoint(store, 'some-ssh-config-alias:/data/')
    expect(resolved.connection).toBeNull()
    expect(resolved.endpoint).toMatchObject({ type: 'ssh', host: 'some-ssh-config-alias' })
    await store.close()
  })

  it('leaves local paths alone', async () => {
    const store = await DiskPushStore.open({ path: ':memory:' })
    expect((await resolveEndpoint(store, './dist/')).endpoint).toEqual({ type: 'local', path: './dist/' })
    await store.close()
  })
})

describe('optionsFromFlags', () => {
  it('starts from the safe defaults', () => {
    const options = optionsFromFlags(parseArgv(['sync', './a/', './b/']))
    expect(options).toMatchObject({
      archive: true,
      partial: true,
      partialDir: '.rsync-partial',
      deleteMode: 'off',
      checksum: false,
    })
  })

  it('applies a preset, then the structured flags on top of it', () => {
    const options = optionsFromFlags(parseArgv(['sync', './a/', './b/', '--preset', 'slow-wan', '--bwlimit', '10M']))
    expect(options.compression).toBe('zstd')
    expect(options.bwlimit).toBe('10M')
  })

  it('carries raw args through without interpreting them', () => {
    const options = optionsFromFlags(parseArgv(['sync', './a/', './b/', '--', '-aHAX', '--checksum']))
    expect(options.rawArgs).toEqual(['-aHAX', '--checksum'])
    // The DiskPush-level option is untouched: only rsync sees the raw token.
    expect(options.checksum).toBe(false)
  })

  it('expands an exclude preset alongside explicit excludes', () => {
    const options = optionsFromFlags(
      parseArgv(['sync', './a/', './b/', '--exclude', 'private/', '--exclude-preset', 'node']),
    )
    expect(options.excludes).toContain('private/')
    expect(options.excludes).toContain('node_modules/')
  })

  it('rejects an unknown exclude preset by name', () => {
    expect(() => optionsFromFlags(parseArgv(['sync', './a/', './b/', '--exclude-preset', 'nope']))).toThrow(
      /Unknown exclude preset/,
    )
  })

  it('defaults --compress to zstd but honours an explicit algorithm', () => {
    expect(optionsFromFlags(parseArgv(['sync', './a/', './b/', '--compress'])).compression).toBe('zstd')
    expect(optionsFromFlags(parseArgv(['sync', './a/', './b/', '--compress=zlib'])).compression).toBe('zlib')
  })
})
