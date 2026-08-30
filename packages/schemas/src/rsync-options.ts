import { z } from 'zod'

export const DeleteModeSchema = z.enum(['off', 'delay', 'during', 'after'])
export type DeleteMode = z.infer<typeof DeleteModeSchema>

export const CompressionSchema = z.enum(['auto', 'off', 'zlib', 'zstd'])
export type Compression = z.infer<typeof CompressionSchema>

export const WholeFileSchema = z.enum(['auto', 'on', 'off'])
export type WholeFile = z.infer<typeof WholeFileSchema>

/**
 * The complete set of rsync behaviour DiskPush will generate flags for.
 * Anything not represented here cannot be produced by the builder; users who
 * need more reach for raw pass-through args, which are token-checked separately.
 */
export const RsyncOptionsSchema = z.object({
  // --- defaults that make DiskPush DiskPush -------------------------------
  archive: z.boolean().default(true),
  partial: z.boolean().default(true),
  partialDir: z.string().min(1).nullable().default('.rsync-partial'),
  humanReadable: z.boolean().default(true),
  itemizeChanges: z.boolean().default(true),
  /** `-ii`: also itemize items that need no change. Powers the "Unchanged" rows. */
  itemizeAll: z.boolean().default(false),
  progress: z.boolean().default(true),
  /**
   * rsync's own `--progress`: a per-file progress line rather than the single
   * aggregate one. Mutually exclusive with `--info=progress2`, because
   * whichever info flag comes last wins.
   */
  perFileProgress: z.boolean().default(false),
  stats: z.boolean().default(false),

  // --- synchronisation semantics ------------------------------------------
  deleteMode: DeleteModeSchema.default('off'),
  checksum: z.boolean().default(false),
  update: z.boolean().default(false),
  ignoreExisting: z.boolean().default(false),
  existingOnly: z.boolean().default(false),

  // --- metadata ------------------------------------------------------------
  hardLinks: z.boolean().default(false),
  acls: z.boolean().default(false),
  xattrs: z.boolean().default(false),
  numericIds: z.boolean().default(false),
  sparse: z.boolean().default(false),

  // --- filters -------------------------------------------------------------
  excludes: z.array(z.string().min(1)).default([]),
  includes: z.array(z.string().min(1)).default([]),
  excludeFrom: z.string().min(1).nullable().default(null),
  includeFrom: z.string().min(1).nullable().default(null),
  filesFrom: z.string().min(1).nullable().default(null),
  /**
   * Read `--files-from` as NUL-separated rather than newline-separated.
   *
   * A newline is legal in a filename, so a newline-separated list cannot
   * express every name a directory can hold — rsync splits such a name in two
   * and fails both halves with "No such file or directory". Anything DiskPush
   * generates uses this.
   */
  from0: z.boolean().default(false),
  maxSize: z.string().min(1).nullable().default(null),
  minSize: z.string().min(1).nullable().default(null),
  pruneEmptyDirs: z.boolean().default(false),
  relative: z.boolean().default(false),

  // --- performance / transport --------------------------------------------
  compression: CompressionSchema.default('auto'),
  bwlimit: z.string().min(1).nullable().default(null),
  wholeFile: WholeFileSchema.default('auto'),
  timeoutSeconds: z.number().int().positive().nullable().default(null),
  mkpath: z.boolean().default(false),

  // --- advanced / dangerous ------------------------------------------------
  inplace: z.boolean().default(false),
  appendVerify: z.boolean().default(false),

  // --- run mode ------------------------------------------------------------
  dryRun: z.boolean().default(false),

  /** Remote rsync executable, when it is not simply `rsync` on PATH. */
  rsyncPath: z.string().min(1).nullable().default(null),

  /**
   * Verbatim rsync argument tokens supplied after `--`. Never re-parsed,
   * never joined into a string, never passed through a shell.
   */
  rawArgs: z.array(z.string()).default([]),
})

export type RsyncOptions = z.infer<typeof RsyncOptionsSchema>
export type RsyncOptionsInput = z.input<typeof RsyncOptionsSchema>

export function defaultRsyncOptions(overrides: Partial<RsyncOptionsInput> = {}): RsyncOptions {
  return RsyncOptionsSchema.parse(overrides)
}

/** A `deleteMode` other than `off` means the destination can lose files. */
export function isDestructive(options: Pick<RsyncOptions, 'deleteMode'>): boolean {
  return options.deleteMode !== 'off'
}
