import { z } from 'zod'
import { EndpointSchema } from './endpoint.js'
import { RsyncOptionsSchema } from './rsync-options.js'

export const JobStateSchema = z.enum([
  'queued',
  'scanning',
  'running',
  'paused',
  'interrupted',
  'retrying',
  'completed',
  'failed',
  'cancelled',
])
export type JobState = z.infer<typeof JobStateSchema>

/** States a job will never leave on its own. */
export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled']

/**
 * A job that stopped with data on disk it can reuse. Surfaced as
 * "Interrupted - resumable" rather than "Failed", because it is not the same thing.
 */
export const RESUMABLE_STATES: readonly JobState[] = ['interrupted', 'paused']

export const TransferJobSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1).nullable().default(null),
  source: EndpointSchema,
  destination: EndpointSchema,
  options: RsyncOptionsSchema,
  state: JobStateSchema.default('queued'),
  bytesTotal: z.number().nonnegative().default(0),
  bytesTransferred: z.number().nonnegative().default(0),
  percent: z.number().min(0).max(100).default(0),
  filesTransferred: z.number().int().nonnegative().default(0),
  retryCount: z.number().int().nonnegative().default(0),
  exitCode: z.number().int().nullable().default(null),
  errorSummary: z.string().nullable().default(null),
  logPath: z.string().nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
})

export type TransferJob = z.infer<typeof TransferJobSchema>

export const ChangeActionSchema = z.enum(['add', 'update', 'metadata', 'delete', 'unchanged', 'error'])
export type ChangeAction = z.infer<typeof ChangeActionSchema>

export const ChangeSchema = z.object({
  action: ChangeActionSchema,
  path: z.string(),
  /** rsync's raw 11-character itemize string, kept for the diagnostics view. */
  itemize: z.string().nullable().default(null),
  isDirectory: z.boolean().default(false),
  size: z.number().nonnegative().nullable().default(null),
})

export type Change = z.infer<typeof ChangeSchema>

export type ChangeSummary = {
  add: number
  update: number
  metadata: number
  delete: number
  unchanged: number
  error: number
}

export function summarizeChanges(changes: readonly Change[]): ChangeSummary {
  const summary: ChangeSummary = { add: 0, update: 0, metadata: 0, delete: 0, unchanged: 0, error: 0 }
  for (const change of changes) summary[change.action] += 1
  return summary
}
