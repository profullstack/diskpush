import { z } from 'zod'

/**
 * The IPC contract.
 *
 * Shared by the main process and the renderer so both sides agree, and
 * validated in the main process on every call. The renderer is treated as
 * untrusted input: a compromised renderer must not be able to turn an IPC
 * message into a shell command or an arbitrary filesystem read.
 */

export const IPC = {
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsRemove: 'connections:remove',
  connectionsTest: 'connections:test',
  connectionsImport: 'connections:import',
  connectionsSshConfig: 'connections:ssh-config',

  fsListLocal: 'fs:list-local',
  fsListRemote: 'fs:list-remote',
  fsHomeLocal: 'fs:home-local',
  fsMkdirRemote: 'fs:mkdir-remote',
  fsRenameRemote: 'fs:rename-remote',
  fsDeleteRemote: 'fs:delete-remote',
  fsCreateFileRemote: 'fs:create-file-remote',
  fsMkdirLocal: 'fs:mkdir-local',
  fsRenameLocal: 'fs:rename-local',
  fsDeleteLocal: 'fs:delete-local',
  fsCreateFileLocal: 'fs:create-file-local',

  transfersPreview: 'transfers:preview',
  transfersStart: 'transfers:start',
  transfersCancel: 'transfers:cancel',
  transfersList: 'transfers:list',

  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesRemove: 'profiles:remove',

  fleetServers: 'fleet:servers',
  fleetCommands: 'fleet:commands',
  fleetPreview: 'fleet:preview',
  fleetStart: 'fleet:start',
  fleetCancel: 'fleet:cancel',
  fleetCheck: 'fleet:check',
  fleetRuns: 'fleet:runs',
  fleetCommandSave: 'fleet:command-save',
  fleetCommandRemove: 'fleet:command-remove',
  fleetLists: 'fleet:lists',
  fleetListSave: 'fleet:list-save',
  fleetListRename: 'fleet:list-rename',
  fleetListRemove: 'fleet:list-remove',
  fleetRunDetail: 'fleet:run-detail',

  shellOpenExternal: 'shell:open-external',

  /** Main -> renderer, one channel carrying every job event. */
  eventTransfer: 'event:transfer',
  /** Main -> renderer, one channel carrying every fleet event. */
  eventFleet: 'event:fleet',
} as const

/** A path the renderer asked for. Length-capped, and never joined by the renderer. */
export const PathSchema = z.string().min(1).max(4096)

export const ConnectionIdSchema = z.string().min(1).max(128)

export const EndpointRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), path: PathSchema }),
  z.object({ type: z.literal('ssh'), connectionId: ConnectionIdSchema, path: PathSchema }),
])
export type EndpointRef = z.infer<typeof EndpointRefSchema>

export const ConnectionInputSchema = z.object({
  id: ConnectionIdSchema.optional(),
  name: z.string().min(1).max(128),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  authType: z.enum(['agent', 'key', 'key-passphrase', 'password']).default('agent'),
  keyPath: PathSchema.nullable().default(null),
  defaultLocalPath: PathSchema.nullable().default(null),
  defaultRemotePath: PathSchema.nullable().default(null),
  jumpHost: z.string().max(255).nullable().default(null),
  rsyncPath: PathSchema.nullable().default(null),
  connectTimeoutSeconds: z.number().int().min(1).max(600).default(15),
  keepaliveSeconds: z.number().int().min(1).max(3600).nullable().default(30),
  forwardAgent: z.boolean().default(false),
  tags: z.array(z.string().max(64)).max(32).default([]),
  notes: z.string().max(4096).default(''),
})

/**
 * Transfer options the renderer may set.
 *
 * Deliberately a subset of the engine's option model: the renderer cannot
 * supply raw rsync arguments, a remote shell, or an rsync binary path. Those
 * come from the saved connection in the main process.
 */
export const TransferOptionsSchema = z.object({
  archive: z.boolean().default(true),
  checksum: z.boolean().default(false),
  compression: z.enum(['auto', 'off', 'zlib', 'zstd']).default('auto'),
  deleteMode: z.enum(['off', 'delay']).default('off'),
  hardLinks: z.boolean().default(false),
  acls: z.boolean().default(false),
  xattrs: z.boolean().default(false),
  numericIds: z.boolean().default(false),
  update: z.boolean().default(false),
  ignoreExisting: z.boolean().default(false),
  existingOnly: z.boolean().default(false),
  inplace: z.boolean().default(false),
  excludes: z.array(z.string().min(1).max(512)).max(500).default([]),
  includes: z.array(z.string().min(1).max(512)).max(500).default([]),
  bwlimit: z.string().regex(/^\d+(\.\d+)?[kKmMgG]?$/).nullable().default(null),
  maxSize: z.string().regex(/^\d+(\.\d+)?[kKmMgGtT]?$/).nullable().default(null),
  minSize: z.string().regex(/^\d+(\.\d+)?[kKmMgGtT]?$/).nullable().default(null),
})
export type TransferOptions = z.infer<typeof TransferOptionsSchema>

export const TransferRequestSchema = z.object({
  source: EndpointRefSchema,
  destination: EndpointRefSchema,
  options: TransferOptionsSchema,
  /** Only meaningful for a delete-enabled job, and only after a preview. */
  deletesConfirmed: z.boolean().default(false),
})
export type TransferRequest = z.infer<typeof TransferRequestSchema>

export const JobIdSchema = z.string().uuid()

/**
 * Saving the current pane pair and options as a named profile.
 *
 * The renderer sends the same endpoint references a transfer takes, so a
 * profile can name a saved connection but never a host of its own. The main
 * process resolves them and stores the full endpoints, which is what makes a
 * profile runnable from the CLI too.
 */
export const ProfileSaveSchema = z.object({
  name: z.string().min(1).max(128).refine((value) => value.trim() === value, {
    message: 'A name cannot begin or end with a space.',
  }),
  source: EndpointRefSchema,
  destination: EndpointRefSchema,
  options: TransferOptionsSchema,
})

export const RemotePathRequestSchema = z.object({
  connectionId: ConnectionIdSchema,
  path: PathSchema,
})

export const RenameRequestSchema = z.object({
  connectionId: ConnectionIdSchema,
  from: PathSchema,
  to: PathSchema,
})

/**
 * A single entry name inside a directory — never a path.
 *
 * Every mutating operation takes a directory plus one of these and joins them
 * in the main process, so the renderer cannot walk out of the folder it is
 * showing. `..`, a separator or a NUL would each be a way to do exactly that.
 */
export const EntryNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\') && !name.includes('\0'), {
    message: 'A name cannot contain a path separator.',
  })
  .refine((name) => name !== '.' && name !== '..', { message: 'That name is reserved.' })
  .refine((name) => name.trim() === name, { message: 'A name cannot begin or end with a space.' })

/** Create a directory or an empty file: `name` inside `directory`. */
export const CreateEntryRequestSchema = z.object({
  connectionId: ConnectionIdSchema.optional(),
  directory: PathSchema,
  name: EntryNameSchema,
})

/** Rename `from` to `to`, both inside `directory`. */
export const RenameEntryRequestSchema = z.object({
  connectionId: ConnectionIdSchema.optional(),
  directory: PathSchema,
  from: EntryNameSchema,
  to: EntryNameSchema,
})

/**
 * Delete `name` from `directory`.
 *
 * `isDirectory` is not a hint — the main process refuses when it disagrees
 * with what is actually on disk, so a mislabelled request cannot turn a
 * single unlink into a recursive delete.
 */
export const DeleteEntryRequestSchema = z.object({
  connectionId: ConnectionIdSchema.optional(),
  directory: PathSchema,
  name: EntryNameSchema,
  isDirectory: z.boolean(),
})

/**
 * A fleet request.
 *
 * The renderer names connections by id and supplies script text; it does not
 * assemble a command line, choose an interpreter binary, or supply a remote
 * shell. The main process turns those into an invocation — the same one the
 * CLI builds — so a compromised renderer's worst case is a script running
 * where the user already has a shell, not a command line of its own design.
 */
export const FleetRequestSchema = z.object({
  connectionIds: z.array(ConnectionIdSchema).min(1).max(500),
  script: z.string().min(1).max(256 * 1024),
  interpreter: z.enum(['sh', 'bash', 'raw']).default('sh'),
  sudo: z.boolean().default(false),
  /**
   * Held in memory for one run and written to `sudo -S` on stdin.
   *
   * Never stored, never logged, and never echoed back to the renderer. The
   * cap is here so a renderer cannot use this field to push megabytes through
   * the boundary.
   */
  sudoPassword: z.string().max(1024).optional(),
  workingDirectory: PathSchema.nullable().default(null),
  timeoutSeconds: z.number().int().min(1).max(86400).default(900),
  concurrency: z.number().int().min(1).max(64).default(4),
  onFailure: z.enum(['continue', 'stop']).default('continue'),
  /**
   * The user saw the hazard list and chose to continue.
   *
   * Checked again in the main process rather than trusted from the dialog:
   * `false` here means a script matching a destructive pattern is refused,
   * whatever the renderer believes it showed.
   */
  hazardsConfirmed: z.boolean().default(false),
  /** A saved command this came from, recorded with the run. */
  commandId: z.string().min(1).max(128).nullable().default(null),
  label: z.string().min(1).max(200),
})
export type FleetRequest = z.infer<typeof FleetRequestSchema>

export const FleetCheckRequestSchema = z.object({
  connectionIds: z.array(ConnectionIdSchema).min(1).max(500),
  concurrency: z.number().int().min(1).max(64).default(4),
  timeoutSeconds: z.number().int().min(1).max(3600).default(180),
})

export const FleetRunIdSchema = z.string().min(1).max(128)

/**
 * A saved set of servers.
 *
 * The renderer sends the ids it has ticked; the main process resolves them and
 * stores each member's current name alongside its id, so a list stays readable
 * after a connection is deleted.
 */
export const FleetListNameSchema = z.string().min(1).max(128).refine((name) => name.trim() === name, {
  message: 'A name cannot begin or end with a space.',
})

/**
 * Saving a command from the Fleet view.
 *
 * The same shape the run request takes, minus the servers and the password:
 * a saved command is the *settings*, and which servers to point them at is a
 * separate choice made at run time (or remembered as `targets`).
 */
export const FleetCommandSaveSchema = z.object({
  name: z.string().min(1).max(128).refine((value) => value.trim() === value, {
    message: 'A name cannot begin or end with a space.',
  }),
  description: z.string().max(500).default(''),
  script: z.string().min(1).max(256 * 1024),
  interpreter: z.enum(['sh', 'bash', 'raw']).default('sh'),
  sudo: z.boolean().default(false),
  workingDirectory: PathSchema.nullable().default(null),
  timeoutSeconds: z.number().int().min(1).max(86400).default(900),
  concurrency: z.number().int().min(1).max(64).default(4),
  onFailure: z.enum(['continue', 'stop']).default('continue'),
  /** Remembered so a saved command can carry the servers it is usually for. */
  targets: z.array(z.string().min(1).max(128)).max(500).default([]),
})

export const FleetListSaveSchema = z.object({
  name: FleetListNameSchema,
  description: z.string().max(500).default(''),
  connectionIds: z.array(ConnectionIdSchema).min(1).max(500),
})

export const FleetListRenameSchema = z.object({
  from: FleetListNameSchema,
  to: FleetListNameSchema,
})

/** Only http(s) may be handed to the system browser. */
export const ExternalUrlSchema = z.string().url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'Only http and https URLs can be opened externally.',
})

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
