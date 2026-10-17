import { describe, expect, it } from 'vitest'
import { destinationFor, errorReport } from './fleet-sync'

describe('errorReport', () => {
  it('is the summary, the host, and rsync\'s own lines: what a person pastes', () => {
    const text = errorReport({
      name: 'dev2',
      host: 'dev2.profullstack.com',
      message: 'The destination folder /home/anthony/x could not be created',
      log: ['rsync: [Receiver] mkdir "/home/anthony/x" failed: No such file or directory (2)', 'rsync error: error in file IO (code 11)'],
    })
    expect(text).toBe(
      'Fleet Sync to dev2 (dev2.profullstack.com) failed: The destination folder /home/anthony/x could not be created\n\n' +
        'rsync: [Receiver] mkdir "/home/anthony/x" failed: No such file or directory (2)\nrsync error: error in file IO (code 11)',
    )
  })

  it('stands alone when rsync said nothing', () => {
    expect(errorReport({ name: 'web1', host: '', message: 'Connection refused', log: [] })).toBe('Fleet Sync to web1 failed: Connection refused')
  })
})

describe('destinationFor', () => {
  it('lands the same path at the same path when the destination is left empty', () => {
    // rsync would otherwise nest the folder: ~/Desktop/me/ideas/ideas.
    expect(destinationFor('~/Desktop/me/ideas', '')).toBe('~/Desktop/me/')
    expect(destinationFor('/srv/app/releases', '  ')).toBe('/srv/app/')
    expect(destinationFor('~/Desktop/me/ideas', '~/Desktop/me/ideas')).toBe('~/Desktop/me/')
  })

  it('keeps a trailing-slash source as is: its contents go to the same folder', () => {
    expect(destinationFor('~/Desktop/me/ideas/', '')).toBe('~/Desktop/me/ideas/')
  })

  it('never rewrites a destination the user typed', () => {
    expect(destinationFor('~/Desktop/me/ideas', '/backup/ideas')).toBe('/backup/ideas')
  })
})
