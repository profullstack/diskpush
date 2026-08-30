import { describe, expect, it } from 'vitest'
import type { Connection } from '@diskpush/schemas'
import { fleetTags, globMatch, parseSelector, selectConnections, SelectionError } from './select.js'

function connection(name: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id: `id-${name}`,
    name,
    host: `${name}.example.com`,
    port: 22,
    username: 'deploy',
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
    ...overrides,
  }
}

const FLEET: Connection[] = [
  connection('web-01', { tags: ['production', 'web'] }),
  connection('web-02', { tags: ['production', 'web'] }),
  connection('web-03', { tags: ['production', 'web', 'canary'] }),
  connection('db-01', { tags: ['production', 'database'], host: '10.0.0.5' }),
  connection('staging-web', { tags: ['staging', 'web'], host: '10.0.9.1' }),
]

describe('parseSelector', () => {
  it('splits commas and trims, so --on a,b matches --on a --on b', () => {
    expect(parseSelector([' web-01 , web-02 ', 'db-01'])).toEqual(['web-01', 'web-02', 'db-01'])
  })

  it('drops empty terms rather than treating them as a match-everything', () => {
    expect(parseSelector(['web-01,,', ''])).toEqual(['web-01'])
  })
})

describe('globMatch', () => {
  it('anchors, so `web` does not match `staging-web`', () => {
    expect(globMatch('web', 'staging-web')).toBe(false)
    expect(globMatch('*web', 'staging-web')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    expect(globMatch('web.01', 'web-01')).toBe(false)
    expect(globMatch('web.01', 'web.01')).toBe(true)
  })
})

describe('selectConnections', () => {
  it('matches by exact name', () => {
    expect(selectConnections(FLEET, ['web-01']).matched.map((c) => c.name)).toEqual(['web-01'])
  })

  it('matches by glob', () => {
    expect(selectConnections(FLEET, ['web-*']).matched.map((c) => c.name)).toEqual(['web-01', 'web-02', 'web-03'])
  })

  it('matches by tag', () => {
    expect(selectConnections(FLEET, ['tag:database']).matched.map((c) => c.name)).toEqual(['db-01'])
  })

  it('matches by hostname glob', () => {
    expect(selectConnections(FLEET, ['host:10.0.0.*']).matched.map((c) => c.name)).toEqual(['db-01'])
  })

  it('selects everything for `all`', () => {
    expect(selectConnections(FLEET, ['all']).matched).toHaveLength(FLEET.length)
  })

  it('unions include terms and dedupes the overlap', () => {
    const selected = selectConnections(FLEET, ['tag:web', 'web-01'])
    expect(selected.matched.map((c) => c.name)).toEqual(['staging-web', 'web-01', 'web-02', 'web-03'])
  })

  it('subtracts exclusions regardless of where they appear', () => {
    const before = selectConnections(FLEET, ['!tag:canary', 'tag:production'])
    const after = selectConnections(FLEET, ['tag:production', '!tag:canary'])
    expect(before.matched.map((c) => c.name)).toEqual(after.matched.map((c) => c.name))
    expect(after.matched.map((c) => c.name)).toEqual(['db-01', 'web-01', 'web-02'])
  })

  it('reports include terms that matched nothing instead of quietly shrinking the fleet', () => {
    const selected = selectConnections(FLEET, ['web-01', 'web-99'])
    expect(selected.matched.map((c) => c.name)).toEqual(['web-01'])
    expect(selected.unmatched).toEqual(['web-99'])
  })

  it('reports an exclusion that matched nothing, because it was meant to protect something', () => {
    const selected = selectConnections(FLEET, ['all', '!web-O3'])
    expect(selected.unmatched).toEqual(['!web-O3'])
    expect(selected.matched.map((c) => c.name)).toContain('web-03')
  })

  it('refuses an empty selector', () => {
    expect(() => selectConnections(FLEET, [])).toThrow(SelectionError)
  })

  it('refuses a selector that is only exclusions', () => {
    expect(() => selectConnections(FLEET, ['!web-01'])).toThrow(/only excludes/)
  })

  it('does not glob-match an id into a neighbour', () => {
    const odd = [connection('a', { id: 'x-1' }), connection('b', { id: 'x-2' })]
    expect(selectConnections(odd, ['x-1']).matched.map((c) => c.id)).toEqual(['x-1'])
  })
})

describe('fleetTags', () => {
  it('lists every tag once, sorted', () => {
    expect(fleetTags(FLEET)).toEqual(['canary', 'database', 'production', 'staging', 'web'])
  })
})
