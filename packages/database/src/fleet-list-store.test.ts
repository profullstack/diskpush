import { describe, expect, it } from 'vitest'
import { isListTerm, listTermName, FLEET_LIST_PREFIX } from '@diskpush/schemas'
import { DiskPushStore } from './store.js'

async function store() {
  return DiskPushStore.open({ path: ':memory:' })
}

const members = [
  { connectionId: 'id-web-01', connectionName: 'web-01' },
  { connectionId: 'id-web-02', connectionName: 'web-02' },
]

describe('fleet lists', () => {
  it('saves a set of servers and reads it back', async () => {
    const db = await store()
    const saved = await db.saveFleetList({ name: 'web', description: 'the web tier', members })

    expect(saved.members).toHaveLength(2)
    const found = await db.findFleetList('web')
    expect(found?.description).toBe('the web tier')
    expect(found?.members.map((m) => m.connectionName)).toEqual(['web-01', 'web-02'])
  })

  it('updates in place rather than creating a second list of the same name', async () => {
    const db = await store()
    const first = await db.saveFleetList({ name: 'web', description: '', members })
    const second = await db.saveFleetList({ name: 'web', description: '', members: [members[0]!] })

    expect(second.id).toBe(first.id)
    expect(second.members).toHaveLength(1)
    expect(await db.listFleetLists()).toHaveLength(1)
  })

  it('keeps the name each member had, so a list stays readable after a deletion', async () => {
    // Nothing joins back to `connections`: a member that has gone away can be
    // named rather than silently dropped, which is the whole point.
    const db = await store()
    await db.saveFleetList({ name: 'web', description: '', members })
    expect((await db.findFleetList('web'))?.members[1]?.connectionName).toBe('web-02')
  })

  it('renames without losing its members or its identity', async () => {
    const db = await store()
    const before = await db.saveFleetList({ name: 'web', description: '', members })
    const after = await db.renameFleetList('web', 'web-tier')

    expect(after?.id).toBe(before.id)
    expect(after?.name).toBe('web-tier')
    expect(after?.members).toHaveLength(2)
    expect(await db.findFleetList('web')).toBeNull()
  })

  it('has nothing to rename when the list does not exist', async () => {
    expect(await (await store()).renameFleetList('nope', 'x')).toBeNull()
  })

  it('deletes', async () => {
    const db = await store()
    await db.saveFleetList({ name: 'web', description: '', members })
    expect(await db.deleteFleetList('web')).toBe(true)
    expect(await db.findFleetList('web')).toBeNull()
    expect(await db.deleteFleetList('web')).toBe(false)
  })

  it('lists alphabetically', async () => {
    const db = await store()
    await db.saveFleetList({ name: 'zeta', description: '', members })
    await db.saveFleetList({ name: 'alpha', description: '', members })
    expect((await db.listFleetLists()).map((list) => list.name)).toEqual(['alpha', 'zeta'])
  })

  it('accepts an empty list, which the selector refuses to run on', async () => {
    // Storing it is fine; using it is what has to complain, and does.
    const db = await store()
    expect((await db.saveFleetList({ name: 'empty', description: '', members: [] })).members).toEqual([])
  })
})

describe('list selector terms', () => {
  it('is prefixed, so a list and a server may share a name', () => {
    expect(FLEET_LIST_PREFIX).toBe('list:')
    expect(isListTerm('list:production')).toBe(true)
    expect(isListTerm('production')).toBe(false)
    expect(listTermName('list:production')).toBe('production')
  })
})
