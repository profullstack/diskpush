import type { Change, ChangeAction, RsyncProgress, RsyncStats } from '@diskpush/schemas'

/**
 * `--info=progress2` writes a single carriage-return-updated line. Its shape
 * depends on whether `--human-readable` is in effect, and DiskPush turns that
 * on by default, so both forms have to parse:
 *
 *     115,343,360  17%  110.02MB/s    0:00:04 (xfr#1, to-chk=11/1024)
 *           8.39M 100%    1.01MB/s    0:00:07 (xfr#1, to-chk=0/2)
 *
 * The human-readable byte column is rounded to three significant figures, so
 * bytesTransferred is approximate whenever that flag is on. That is fine for a
 * progress bar; exact totals come from `--stats`.
 */
const PROGRESS2 =
  /^\s*([\d,.']+)([KMGTP])?\s+(\d+)%\s+([\d.]+)\s*([kKMGTP]?)B\/s\s+(\d+):(\d{2}):(\d{2})(?:\s+\(xfr#(\d+),\s+(?:ir|to)-chk=(\d+)\/(\d+)\))?/

/** rsync's `-h` uses powers of 1000; powers of 1024 are `-hh`, which we never pass. */
const UNIT_MULTIPLIER: Record<string, number> = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }

function multiplierFor(suffix: string | undefined): number {
  return UNIT_MULTIPLIER[(suffix ?? '').toUpperCase()] ?? 1
}

function toNumber(text: string, suffix: string | undefined): number {
  const digits = text.replaceAll(/[,' ]/g, '')
  if (suffix) return Number.parseFloat(digits) * multiplierFor(suffix)
  // With no unit, rsync prints a whole number of bytes, so any punctuation
  // left here is a thousands separator rather than a decimal point.
  return Number(digits.replaceAll('.', ''))
}

export function parseProgressLine(line: string): RsyncProgress | null {
  const match = PROGRESS2.exec(line)
  if (!match) return null

  const rate = Number(match[4]) * multiplierFor(match[5])
  const elapsed = Number(match[6]) * 3600 + Number(match[7]) * 60 + Number(match[8])
  const filesTransferred = match[9] === undefined ? null : Number(match[9])
  const filesRemaining = match[10] === undefined ? null : Number(match[10])
  const filesTotal = match[11] === undefined ? null : Number(match[11])

  return {
    bytesTransferred: toNumber(match[1] ?? '0', match[2]),
    percent: Number(match[3]),
    bytesPerSecond: rate,
    elapsedSeconds: elapsed,
    filesTransferred,
    filesRemaining,
    filesTotal,
  }
}

/**
 * `--itemize-changes` writes an 11-character change string followed by a path:
 *
 *     >f+++++++++ new/video.mp4      file created
 *     >f.st...... site/app.js        contents and time changed
 *     .d..t...... assets/            directory timestamp only
 *     *deleting   old/archive.zip
 */
const ITEMIZE = /^([<>ch.*][fdLDS][a-zA-Z.+? ]{9})\s(.*)$/
const DELETING = /^\*deleting\s+(.*)$/

export function parseItemizeLine(line: string): Change | null {
  const deleting = DELETING.exec(line)
  if (deleting) {
    const path = deleting[1] ?? ''
    return { action: 'delete', path, itemize: '*deleting', isDirectory: path.endsWith('/'), size: null }
  }

  const match = ITEMIZE.exec(line)
  if (!match) return null

  const itemize = match[1] ?? ''
  const path = match[2] ?? ''
  return {
    action: classifyItemize(itemize),
    path,
    itemize,
    isDirectory: itemize[1] === 'd',
    size: null,
  }
}

export function classifyItemize(itemize: string): ChangeAction {
  const update = itemize[0] ?? '.'
  const attributes = itemize.slice(2)
  const allNew = attributes.length > 0 && [...attributes].every((c) => c === '+')

  // `h` is a hard link created at the destination; `c` is a local creation
  // (directory, symlink, device). Both are additions from the user's view.
  if (update === 'h') return 'add'
  if (allNew) return 'add'
  if (update === '<' || update === '>') return 'update'
  if (update === 'c') return 'add'
  if (update === '.') {
    return [...attributes].every((c) => c === '.' || c === ' ') ? 'unchanged' : 'metadata'
  }
  return 'update'
}

const STATS_PATTERNS: Array<[keyof RsyncStats, RegExp]> = [
  ['filesTotal', /^Number of files:\s+([\d,]+)/],
  ['filesTransferred', /^Number of (?:regular files transferred|files transferred):\s+([\d,]+)/],
  ['literalBytes', /^Literal data:\s+([\d,]+)/],
  ['matchedBytes', /^Matched data:\s+([\d,]+)/],
  ['totalBytesSent', /^Total bytes sent:\s+([\d,]+)/],
  ['totalBytesReceived', /^Total bytes received:\s+([\d,]+)/],
]

export function emptyStats(): RsyncStats {
  return {
    filesTotal: null,
    filesTransferred: null,
    totalBytesSent: null,
    totalBytesReceived: null,
    literalBytes: null,
    matchedBytes: null,
    speedup: null,
  }
}

/** Folds one `--stats` line into an accumulating stats object. */
export function parseStatsLine(line: string, into: RsyncStats): boolean {
  for (const [key, pattern] of STATS_PATTERNS) {
    const match = pattern.exec(line)
    if (match) {
      into[key] = Number((match[1] ?? '').replaceAll(',', ''))
      return true
    }
  }
  const speedup = /^(?:total size is [\d,]+\s+)?speedup is ([\d.]+)/i.exec(line)
  if (speedup) {
    into.speedup = Number(speedup[1])
    return true
  }
  return false
}

/**
 * Splits a chunk of rsync output into lines.
 *
 * Progress uses `\r` to overwrite in place, so both terminators have to count
 * as line boundaries or the progress line never arrives until the job ends.
 */
export function splitOutputLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\r|\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}
