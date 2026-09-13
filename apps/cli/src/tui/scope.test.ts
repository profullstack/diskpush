/**
 * What a preview or sync covers, as a pure function of the two panes.
 *
 * Before this, both keys always synced the whole of one pane into the whole
 * of the other, whatever was under the cursor, which is not what a person
 * who has just unfolded a directory and pressed `p` meant.
 */
import { describe, expect, it } from 'vitest'
import type { Connection } from '@diskpush/schemas'
import { blankPane, scopeTransfer, type Entry } from './model.js'

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({ name, isDirectory: false, size: 0, modifiedAt: null, ...over })

const prod = { id: 'c1', name: 'prod', host: 'prod.example', username: 'deploy', port: 22 } as unknown as Connection

function panes() {
  const local = blankPane('Local', '/home/me/project')
  local.entries = [entry('src', { isDirectory: true }), entry('README.md')]
  local.children.set('src', [entry('lib', { isDirectory: true }), entry('index.ts')])
  local.unfolded.add('src')
  const remote = blankPane('prod', '/srv/app', prod)
  return { local, remote }
}

describe('scopeTransfer', () => {
  it('mirrors the selected directory to the same relative path in the other pane', () => {
    const { local, remote } = panes()
    local.index = 0
    expect(scopeTransfer(local, remote)).toEqual({
      from: '/home/me/project/src/',
      to: 'deploy@prod.example:/srv/app/src/',
      what: 'src',
    })
    // Nested rows keep their whole relative path, so the trees stay aligned.
    local.index = 1
    expect(scopeTransfer(local, remote)).toEqual({
      from: '/home/me/project/src/lib/',
      to: 'deploy@prod.example:/srv/app/src/lib/',
      what: 'src/lib',
    })
  })

  it('sends a selected file into the directory that holds it over there', () => {
    const { local, remote } = panes()
    local.index = 2 // src/index.ts
    expect(scopeTransfer(local, remote)).toEqual({
      from: '/home/me/project/src/index.ts',
      to: 'deploy@prod.example:/srv/app/src/',
      what: 'src/index.ts',
    })
    local.index = 3 // README.md at the root
    expect(scopeTransfer(local, remote)).toEqual({
      from: '/home/me/project/README.md',
      to: 'deploy@prod.example:/srv/app/',
      what: 'README.md',
    })
  })

  it('covers the whole pane when there is nothing under the cursor', () => {
    const { local, remote } = panes()
    local.entries = []
    local.unfolded.clear()
    expect(scopeTransfer(local, remote)).toEqual({
      from: '/home/me/project/',
      to: 'deploy@prod.example:/srv/app/',
      what: 'everything',
    })
  })

  it('works in either direction, remote to local included', () => {
    const { local, remote } = panes()
    remote.entries = [entry('logs', { isDirectory: true })]
    expect(scopeTransfer(remote, local)).toEqual({
      from: 'deploy@prod.example:/srv/app/logs/',
      to: '/home/me/project/logs/',
      what: 'logs',
    })
  })
})
