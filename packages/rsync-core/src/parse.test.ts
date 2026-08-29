import { describe, expect, it } from 'vitest'
import { classifyItemize, emptyStats, parseItemizeLine, parseProgressLine, parseStatsLine, splitOutputLines } from './parse.js'

describe('parseProgressLine', () => {
  it('reads a progress2 line without a transfer suffix', () => {
    const progress = parseProgressLine('        651,264   0%    0.00kB/s    0:00:00')
    expect(progress).toMatchObject({ bytesTransferred: 651264, percent: 0, bytesPerSecond: 0, elapsedSeconds: 0 })
  })

  it('reads the transfer suffix when rsync emits it', () => {
    const progress = parseProgressLine('    115,343,360  17%  110.02MB/s    0:00:04 (xfr#1, to-chk=11/1024)')
    expect(progress).toMatchObject({
      bytesTransferred: 115343360,
      percent: 17,
      elapsedSeconds: 4,
      filesTransferred: 1,
      filesRemaining: 11,
      filesTotal: 1024,
    })
    expect(progress!.bytesPerSecond).toBeCloseTo(110.02e6)
  })

  it('handles the incremental-recursion form of the counter', () => {
    const progress = parseProgressLine('  1,234,567  99%    1.10GB/s    1:02:03 (xfr#42, ir-chk=3/99)')
    expect(progress).toMatchObject({ filesTransferred: 42, filesRemaining: 3, filesTotal: 99 })
    expect(progress!.elapsedSeconds).toBe(3723)
  })

  it('reads the human-readable byte column that --human-readable produces', () => {
    // This is the shape DiskPush actually sees, because -h is on by default.
    const progress = parseProgressLine('          8.39M 100%    1.01MB/s    0:00:07 (xfr#1, to-chk=0/2)')
    expect(progress).toMatchObject({ percent: 100, filesTransferred: 1, filesRemaining: 0, filesTotal: 2 })
    expect(progress!.bytesTransferred).toBeCloseTo(8.39e6)
  })

  it('reads a kilobyte-suffixed byte column', () => {
    const progress = parseProgressLine('         32.77K   0%    0.00kB/s    0:00:00  ')
    expect(progress!.bytesTransferred).toBeCloseTo(32770)
    expect(progress!.bytesPerSecond).toBe(0)
  })

  it('distinguishes the K in the byte column from the k in the rate', () => {
    const progress = parseProgressLine('          1.08M  12% 1024.00kB/s    0:00:07  ')
    expect(progress!.bytesTransferred).toBeCloseTo(1.08e6)
    expect(progress!.bytesPerSecond).toBeCloseTo(1024e3)
  })

  it('returns null for anything that is not a progress line', () => {
    expect(parseProgressLine('>f+++++++++ file.txt')).toBeNull()
    expect(parseProgressLine('sending incremental file list')).toBeNull()
  })
})

describe('parseItemizeLine', () => {
  it('classifies a newly created file as an addition', () => {
    expect(parseItemizeLine('>f+++++++++ new/video.mp4')).toMatchObject({ action: 'add', path: 'new/video.mp4' })
  })

  it('classifies a changed file as an update', () => {
    expect(parseItemizeLine('>f.st...... site/app.js')).toMatchObject({ action: 'update', path: 'site/app.js' })
  })

  it('classifies a timestamp-only change as metadata', () => {
    expect(parseItemizeLine('.d..t...... assets/')).toMatchObject({ action: 'metadata', isDirectory: true })
  })

  it('classifies an all-dots line as unchanged', () => {
    expect(parseItemizeLine('.f          README.md')).toMatchObject({ action: 'unchanged', path: 'README.md' })
  })

  it('reads a deletion', () => {
    expect(parseItemizeLine('*deleting   old/archive.zip')).toMatchObject({
      action: 'delete',
      path: 'old/archive.zip',
    })
  })

  it('marks a deleted directory as a directory', () => {
    expect(parseItemizeLine('*deleting   old/dir/')).toMatchObject({ action: 'delete', isDirectory: true })
  })

  it('keeps a path containing spaces intact', () => {
    expect(parseItemizeLine('>f+++++++++ my folder/a b.txt')).toMatchObject({ path: 'my folder/a b.txt' })
  })

  it('returns null for narrative output', () => {
    expect(parseItemizeLine('sending incremental file list')).toBeNull()
    expect(parseItemizeLine('')).toBeNull()
  })
})

describe('classifyItemize', () => {
  it('treats a created directory as an addition', () => {
    expect(classifyItemize('cd+++++++++')).toBe('add')
  })

  it('treats a created hard link as an addition', () => {
    expect(classifyItemize('hf+++++++++')).toBe('add')
  })

  it('treats a received update as an update', () => {
    expect(classifyItemize('<f.st......')).toBe('update')
  })
})

describe('parseStatsLine', () => {
  it('accumulates the --stats block', () => {
    const stats = emptyStats()
    for (const line of [
      'Number of files: 8,442 (reg: 8,000, dir: 442)',
      'Number of regular files transferred: 173',
      'Literal data: 1,234,567 bytes',
      'Matched data: 89 bytes',
      'Total bytes sent: 1,300,000',
      'Total bytes received: 35',
      'total size is 14,800,000  speedup is 11.38',
    ]) {
      expect(parseStatsLine(line, stats)).toBe(true)
    }
    expect(stats).toMatchObject({
      filesTotal: 8442,
      filesTransferred: 173,
      literalBytes: 1234567,
      totalBytesSent: 1300000,
      speedup: 11.38,
    })
  })

  it('ignores lines that are not stats', () => {
    expect(parseStatsLine('>f+++++++++ a.txt', emptyStats())).toBe(false)
  })
})

describe('splitOutputLines', () => {
  it('treats a carriage return as a line boundary so progress arrives live', () => {
    const { lines, rest } = splitOutputLines('  10%\r  20%\r  30')
    expect(lines).toEqual(['  10%', '  20%'])
    expect(rest).toBe('  30')
  })

  it('holds an incomplete trailing line back for the next chunk', () => {
    const { lines, rest } = splitOutputLines('done\npartial')
    expect(lines).toEqual(['done'])
    expect(rest).toBe('partial')
  })
})
