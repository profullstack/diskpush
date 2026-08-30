import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertSelectable, describeSelection, SelectionError, writeSelectionList } from './selection.js'
import { buildRsyncArgs } from './args.js'
import { defaultRsyncOptions } from '@diskpush/schemas'

describe('assertSelectable', () => {
  it('accepts an ordinary entry name', () => {
    expect(() => assertSelectable('one.txt')).not.toThrow()
    expect(() => assertSelectable('a folder')).not.toThrow()
    expect(() => assertSelectable('nested/deep.txt')).not.toThrow()
  })

  it('refuses anything that climbs out of the source directory', () => {
    expect(() => assertSelectable('..')).toThrow(SelectionError)
    expect(() => assertSelectable('../etc/passwd')).toThrow(/climb out/)
    expect(() => assertSelectable('a/../../b')).toThrow(/climb out/)
  })

  it('refuses an absolute path, which would ignore the source entirely', () => {
    expect(() => assertSelectable('/etc/passwd')).toThrow(/relative to the source/)
  })

  it('refuses names that are not names', () => {
    expect(() => assertSelectable('')).toThrow(SelectionError)
    expect(() => assertSelectable('.')).toThrow(SelectionError)
    expect(() => assertSelectable('a//b')).toThrow(SelectionError)
    expect(() => assertSelectable('a\0b')).toThrow(/NUL/)
  })
})

describe('writeSelectionList', () => {
  it('writes a NUL-separated, NUL-terminated list', () => {
    const list = writeSelectionList(['one.txt', 'keep'])
    try {
      expect(readFileSync(list.path, 'utf8')).toBe('one.txt\0keep\0')
    } finally {
      list.cleanup()
    }
  })

  it('can express a name containing a newline, which a line-based list cannot', () => {
    // rsync splits such a name across two entries in a newline-separated list
    // and fails both halves with "No such file or directory".
    const list = writeSelectionList(['new\nline.txt'])
    try {
      expect(readFileSync(list.path, 'utf8')).toBe('new\nline.txt\0')
    } finally {
      list.cleanup()
    }
  })

  it('removes the list, and does not mind being told twice', () => {
    const list = writeSelectionList(['a'])
    expect(existsSync(list.path)).toBe(true)
    list.cleanup()
    expect(existsSync(list.path)).toBe(false)
    expect(() => list.cleanup()).not.toThrow()
  })

  it('refuses an empty selection rather than silently sending everything', () => {
    expect(() => writeSelectionList([])).toThrow(/Nothing was selected/)
  })

  it('validates every name, not just the first', () => {
    expect(() => writeSelectionList(['fine.txt', '../escape'])).toThrow(/climb out/)
  })
})

describe('buildRsyncArgs with a selection', () => {
  const endpoints = {
    source: { type: 'local' as const, path: '/src/' },
    destination: { type: 'local' as const, path: '/dst/' },
  }

  it('restates --recursive, which --files-from turns off', () => {
    /*
     * Verified against rsync 3.4.1: with `-a --files-from` a selected folder
     * arrives as an EMPTY directory, and `--archive` does not save you. Only
     * an explicit `-r` brings its contents. Without this the feature looks
     * like it works and silently transfers nothing inside a folder.
     */
    const built = buildRsyncArgs({
      ...endpoints,
      options: { ...defaultRsyncOptions(), filesFrom: '/tmp/list', from0: true },
    })
    expect(built.args).toContain('--recursive')
    expect(built.args).toContain('--from0')
    expect(built.args).toContain('--files-from=/tmp/list')
  })

  it('does not add --from0 unless asked, so a hand-written list still works', () => {
    const built = buildRsyncArgs({
      ...endpoints,
      options: { ...defaultRsyncOptions(), filesFrom: '/tmp/list' },
    })
    expect(built.args).not.toContain('--from0')
    expect(built.args).toContain('--files-from=/tmp/list')
  })

  it('leaves an ordinary transfer alone', () => {
    const built = buildRsyncArgs({ ...endpoints, options: defaultRsyncOptions() })
    expect(built.args).not.toContain('--from0')
    expect(built.args.some((arg) => arg.startsWith('--files-from'))).toBe(false)
  })
})

describe('describeSelection', () => {
  it('names a single entry, and counts the rest', () => {
    expect(describeSelection(['one.txt'])).toBe('one.txt')
    expect(describeSelection(['a', 'b', 'c'])).toBe('3 selected entries')
  })
})
