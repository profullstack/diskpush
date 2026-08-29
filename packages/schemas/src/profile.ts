import { z } from 'zod'
import { EndpointSchema } from './endpoint.js'
import { RsyncOptionsSchema } from './rsync-options.js'

export const PresetNameSchema = z.enum([
  'fast-sync',
  'exact-mirror',
  'maximum-metadata',
  'slow-wan',
  'verify-everything',
])
export type PresetName = z.infer<typeof PresetNameSchema>

export const ScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  /** `every-5m` … `daily`, or `cron` with an expression. */
  kind: z.enum(['every-5m', 'every-15m', 'hourly', 'daily', 'cron']).default('daily'),
  cron: z.string().min(1).nullable().default(null),
})

export const WatchSchema = z.object({
  enabled: z.boolean().default(false),
  debounceMs: z.number().int().min(100).default(1000),
})

export const SyncProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: EndpointSchema,
  destination: EndpointSchema,
  preset: PresetNameSchema.default('fast-sync'),
  options: RsyncOptionsSchema,
  /**
   * Off by default and deliberately awkward to turn on: it is the only way a
   * mirror runs without a human looking at the delete list first.
   */
  trustDeletes: z.boolean().default(false),
  schedule: ScheduleSchema.default({}),
  watch: WatchSchema.default({}),
  notifyOnSuccess: z.boolean().default(false),
  notifyOnFailure: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type SyncProfile = z.infer<typeof SyncProfileSchema>
export type Schedule = z.infer<typeof ScheduleSchema>
export type Watch = z.infer<typeof WatchSchema>
