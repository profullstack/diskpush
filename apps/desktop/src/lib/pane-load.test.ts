import { describe, expect, it } from 'vitest'
import { blankPane, placeholderPane, shouldLoadPane } from './pane-load.js'

describe('when a pane loads', () => {
  it('does not load the launch placeholder', () => {
    expect(shouldLoadPane(placeholderPane(), false)).toBe(false)
  })

  /*
   * The bug: "not yet initialised" was spelled `path === '/'`, so a bucket
   * with no default path (which opens at its root, `/`) sat on a skeleton
   * forever and fs.listRemote was never called.
   */
  it('loads a bucket pane at its root', () => {
    expect(shouldLoadPane(blankPane({ kind: 'ssh', connectionId: 'bucket' }, '/'), false)).toBe(true)
  })

  it('loads "This computer" at /', () => {
    expect(shouldLoadPane(blankPane({ kind: 'local' }, '/'), false)).toBe(true)
  })

  it('loads nothing outside the desktop shell', () => {
    expect(shouldLoadPane(blankPane({ kind: 'local' }, '/home/me'), true)).toBe(false)
  })
})
