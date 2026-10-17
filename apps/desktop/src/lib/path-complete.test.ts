import { describe, expect, it } from 'vitest'
import { listingPath, splitForCompletion, suggestions, tabComplete, type CompletionEntry } from './path-complete'

const home: CompletionEntry[] = [
  { name: 'projects', type: 'directory' },
  { name: 'Documents', type: 'directory' },
  { name: 'downloads', type: 'directory' },
  { name: 'notes.md', type: 'file' },
  { name: '.config', type: 'directory' },
  { name: 'site', type: 'symlink', targetType: 'directory' },
  { name: 'projections.txt', type: 'file' },
]

describe('splitForCompletion', () => {
  it('splits at the last slash, and treats a bare ~ as ~/', () => {
    expect(splitForCompletion('~/pro')).toEqual({ dir: '~/', prefix: 'pro' })
    expect(splitForCompletion('/home/')).toEqual({ dir: '/home/', prefix: '' })
    expect(splitForCompletion('/ho')).toEqual({ dir: '/', prefix: 'ho' })
    expect(splitForCompletion('~')).toEqual({ dir: '~/', prefix: '' })
    expect(splitForCompletion('pro')).toEqual({ dir: '', prefix: 'pro' })
  })
})

describe('listingPath', () => {
  it('keeps ~ for local listings, which expand it', () => {
    expect(listingPath('~/', 'local')).toBe('~/')
    expect(listingPath('', 'local')).toBe('~')
  })
  it('maps ~ to SFTP-relative paths, which start at home', () => {
    expect(listingPath('~/', 'remote')).toBe('.')
    expect(listingPath('', 'remote')).toBe('.')
    expect(listingPath('~/www/', 'remote')).toBe('www/')
    expect(listingPath('/var/', 'remote')).toBe('/var/')
  })
})

describe('suggestions', () => {
  it('offers matches as full values, directories first, with a trailing slash', () => {
    expect(suggestions('~/pro', home).map((s) => s.value)).toEqual(['~/projects/', '~/projections.txt'])
    expect(suggestions('~/', home).map((s) => s.label)).toEqual(['Documents/', 'downloads/', 'projects/', 'site/', 'notes.md', 'projections.txt'])
  })

  it('treats a symlink to a directory as a directory', () => {
    expect(suggestions('~/si', home)[0]).toEqual({ value: '~/site/', label: 'site/', isDirectory: true })
  })

  it('hides dotfiles unless the prefix starts with a dot', () => {
    expect(suggestions('~/', home).some((s) => s.label === '.config/')).toBe(false)
    expect(suggestions('~/.c', home).map((s) => s.value)).toEqual(['~/.config/'])
  })

  it('falls back to case-insensitive only when nothing matches exactly', () => {
    expect(suggestions('~/do', home).map((s) => s.label)).toEqual(['downloads/'])
    expect(suggestions('~/doc', home).map((s) => s.label)).toEqual(['Documents/'])
  })
})

describe('tabComplete', () => {
  it('completes the one match, or the shared prefix of several', () => {
    expect(tabComplete('~/proj', suggestions('~/proj', home))).toBe('~/project')
    expect(tabComplete('~/projects', suggestions('~/projects', home))).toBe('~/projects/')
    expect(tabComplete('~/x', suggestions('~/x', home))).toBeNull()
  })
})
