import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connection } from '@diskpush/schemas'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const saved = new Map<string, Connection>()

vi.mock('./store.js', () => ({
  store: async () => ({ findConnection: async (id: string) => saved.get(id) ?? null }),
}))

const { requireConnection, resolveConnection } = await import('./connections.js')

beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'diskpush-ssh-config-'))
  const path = join(directory, 'config')
  writeFileSync(path, 'Host seed1\n  HostName seed1.example.com\n  User deploy\n  Port 2222\n')
  process.env.DISKPUSH_SSH_CONFIG = path
})

afterEach(() => saved.clear())

describe('resolveConnection', () => {
  // The bug this exists to prevent: the picker offers ~/.ssh/config hosts but
  // never saves them, so a database-only lookup made every one of them fail
  // with "That connection no longer exists" the moment it was selected — and
  // on a machine with no saved connections, that was every server in the list.
  it('resolves a host that only exists in ~/.ssh/config', async () => {
    const connection = await resolveConnection('ssh-config:seed1')
    expect(connection?.host).toBe('seed1.example.com')
    expect(connection?.username).toBe('deploy')
    expect(connection?.port).toBe(2222)
  })

  it('prefers the saved row when an imported host was edited afterwards', async () => {
    saved.set('ssh-config:seed1', { id: 'ssh-config:seed1', host: 'edited.example.com' } as Connection)
    expect((await resolveConnection('ssh-config:seed1'))?.host).toBe('edited.example.com')
  })

  it('resolves a saved connection by its own id', async () => {
    saved.set('abc-123', { id: 'abc-123', host: 'saved.example.com' } as Connection)
    expect((await resolveConnection('abc-123'))?.host).toBe('saved.example.com')
  })

  it('does not read ssh_config for an id that never came from it', async () => {
    expect(await resolveConnection('deleted-uuid')).toBeNull()
  })

  it('still reports a host that has since left ssh_config', async () => {
    expect(await resolveConnection('ssh-config:gone')).toBeNull()
    await expect(requireConnection('ssh-config:gone')).rejects.toThrow('That connection no longer exists.')
  })
})
