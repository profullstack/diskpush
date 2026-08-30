import { describe, expect, it } from 'vitest'
import { isNavigable } from './entries.js'

describe('isNavigable', () => {
  /**
   * The bug this exists to prevent: `~/data -> /mnt/vdb` on a server was a row
   * that could not be opened. SFTP's readdir types a link the way lstat does,
   * and the pane only walked into rows typed `directory`, so every
   * double-click on it did nothing at all.
   */
  it('opens a link that points at a directory', () => {
    expect(isNavigable({ type: 'symlink', targetType: 'directory' })).toBe(true)
  })

  it('does not open a link that points at a file', () => {
    expect(isNavigable({ type: 'symlink', targetType: 'file' })).toBe(false)
  })

  it('does not open a link whose target could not be resolved', () => {
    // A broken link, or one pointing where this user cannot stat: there is
    // nothing to walk into, and guessing yes turns a click into an error.
    expect(isNavigable({ type: 'symlink', targetType: undefined })).toBe(false)
  })

  it('opens a real directory', () => {
    expect(isNavigable({ type: 'directory' })).toBe(true)
  })

  it('does not open a file, whatever a stale targetType says', () => {
    expect(isNavigable({ type: 'file', targetType: 'directory' })).toBe(false)
  })
})
