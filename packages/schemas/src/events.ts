import type { Change } from './job.js'

/** Structured progress, parsed out of `--info=progress2`. */
export type RsyncProgress = {
  bytesTransferred: number
  percent: number
  /** Bytes per second, normalised from rsync's human-readable rate. */
  bytesPerSecond: number
  elapsedSeconds: number
  filesTransferred: number | null
  filesRemaining: number | null
  filesTotal: number | null
}

export type RsyncStats = {
  filesTotal: number | null
  filesTransferred: number | null
  totalBytesSent: number | null
  totalBytesReceived: number | null
  literalBytes: number | null
  matchedBytes: number | null
  speedup: number | null
}

export type RsyncEvent =
  | { type: 'start'; command: string; args: readonly string[] }
  | { type: 'progress'; progress: RsyncProgress }
  | { type: 'change'; change: Change }
  | { type: 'file'; path: string }
  | { type: 'stats'; stats: RsyncStats }
  | { type: 'stderr'; line: string }
  | { type: 'stdout'; line: string }
  | { type: 'exit'; code: number; signal: NodeJS.Signals | null; resumable: boolean; message: string }
