import { describe, expect, it } from 'vitest'
import { destinationFor, errorReport, formatPercent, progressDetail, recordFile, type FileRow } from './fleet-sync'

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

describe('progress', () => {
  it('shows a decimal below 10%, so a 300 GB transfer does not read 0% for hours', () => {
    expect(formatPercent(0.19)).toBe('0.1%')
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(42.7)).toBe('42%')
    expect(formatPercent(100)).toBe('100%')
  })

  it('works out the total and the time left from bytes, percent and rate', () => {
    const line = progressDetail({ percent: 0.19, bytesTransferred: 570e6, bytesPerSecond: 4.2e6 })
    // 570 MB is 0.19% of 300 GB; at 4.2 MB/s the other 299.4 GB take about 19 h 48 m.
    expect(line).toMatch(/^0\.1% · 570\.0 MB of ~300\.0 GB · 4 MB\/s · ~19:48:\d\d left$/)
  })

  it('says only what it knows at the very start', () => {
    expect(progressDetail({ percent: 0, bytesTransferred: 0, bytesPerSecond: 0 })).toMatch(/^0\.0% · 0/)
  })
})

describe('the file list', () => {
  it('keeps the newest first, one row per path, capped', () => {
    let rows: FileRow[] = []
    rows = recordFile(rows, { action: 'add', path: 'a.mkv', size: 10 }, 3)
    rows = recordFile(rows, { action: 'add', path: 'b.mkv', size: 20 }, 3)
    rows = recordFile(rows, { action: 'update', path: 'a.mkv', size: 11 }, 3)
    rows = recordFile(rows, { action: 'add', path: 'c.mkv', size: 30 }, 3)
    rows = recordFile(rows, { action: 'add', path: 'd.mkv', size: 40 }, 3)
    expect(rows.map((r) => r.path)).toEqual(['d.mkv', 'c.mkv', 'a.mkv'])
  })

  it('ignores what is not a file being sent', () => {
    expect(recordFile([], { action: 'unchanged', path: 'x', size: 1 })).toEqual([])
    expect(recordFile([], { action: 'add', path: 'dir/', size: null, isDirectory: true })).toEqual([])
  })
})
