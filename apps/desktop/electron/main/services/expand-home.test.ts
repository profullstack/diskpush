import { describe, expect, it, vi } from 'vitest'

// transfers.js reaches for the store and rsync-core at import time; neither matters here.
vi.mock('./store.js', () => ({ store: async () => ({}) }))
vi.mock('@diskpush/rsync-core', () => ({}))

const { expandHome } = await import('./transfers.js')

describe('expandHome', () => {
  it('expands ~ and ~/x to the home directory, keeping a trailing slash', () => {
    expect(expandHome('~', '/home/ada')).toBe('/home/ada')
    expect(expandHome('~/site/', '/home/ada')).toBe('/home/ada/site/')
    expect(expandHome('~/site', '/home/ada/')).toBe('/home/ada/site')
  })

  it('leaves every other path alone, including ~user and a ~ inside a name', () => {
    expect(expandHome('/srv/~/x', '/home/ada')).toBe('/srv/~/x')
    expect(expandHome('~bob/x', '/home/ada')).toBe('~bob/x')
    expect(expandHome('./~', '/home/ada')).toBe('./~')
  })
})
