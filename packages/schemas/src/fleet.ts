import { z } from 'zod'

/**
 * Fleet operations: one command, many servers.
 *
 * The transfer engine moves bytes to a server. This moves *work* to a set of
 * them — a package upgrade, a health check, a script you already have — and
 * reports each host separately, because "it worked" across twelve machines is
 * a claim that has to be true of all twelve to be worth printing.
 *
 * Nothing here holds a credential. A sudo password, when one is needed, is
 * held in memory for the length of a run and written to the remote process's
 * stdin; it is never a column, a setting, or a log line.
 */

/** How the script reaches the remote host. */
export const FleetInterpreterSchema = z.enum([
  /** POSIX shell. The default, and the only one every server is certain to have. */
  'sh',
  'bash',
  /** Run the text as a single command line, unwrapped. */
  'raw',
])
export type FleetInterpreter = z.infer<typeof FleetInterpreterSchema>

/**
 * How a run treats a host that fails.
 *
 * `continue` finishes the fleet and reports; `stop` cancels the hosts that
 * have not started yet, which is what you want when the command is one step
 * of a rollout rather than an independent errand.
 */
export const FleetFailureModeSchema = z.enum(['continue', 'stop'])
export type FleetFailureMode = z.infer<typeof FleetFailureModeSchema>

/** When a successful upgrade is allowed to reboot the server. */
export const FleetRebootPolicySchema = z.enum(['never', 'if-needed', 'always'])
export type FleetRebootPolicy = z.infer<typeof FleetRebootPolicySchema>

export const FLEET_DEFAULT_CONCURRENCY = 4
export const FLEET_DEFAULT_TIMEOUT_SECONDS = 900
/** Per host, per stream. Beyond this the tail is kept and the middle dropped. */
export const FLEET_MAX_CAPTURED_BYTES = 256 * 1024

/**
 * A saved command. The fleet equivalent of a sync profile: a thing you named
 * once so that running it again is not retyping it.
 */
export const FleetCommandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  script: z.string().min(1),
  interpreter: FleetInterpreterSchema.default('sh'),
  /** Run through `sudo`. See `sudoMode` on the request for how it authenticates. */
  sudo: z.boolean().default(false),
  /** `cd` here first. Null runs in the login directory. */
  workingDirectory: z.string().min(1).nullable().default(null),
  timeoutSeconds: z.number().int().positive().default(FLEET_DEFAULT_TIMEOUT_SECONDS),
  /**
   * Default target selector, in the same syntax `--on` takes. Saved with the
   * command so `diskpush fleet run deploy-reload` needs no `--on` at all.
   */
  /**
   * How the run is paced. Stored with the command because "reload nginx" and
   * "upgrade the database tier" want very different answers, and re-choosing
   * them every time is how a saved command still gets run wrong.
   */
  concurrency: z.number().int().positive().default(FLEET_DEFAULT_CONCURRENCY),
  onFailure: FleetFailureModeSchema.default('continue'),
  targets: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string()).default([]),
  /**
   * True for the recipes DiskPush ships. They are listed alongside saved
   * commands but cannot be edited or deleted, only copied.
   */
  builtin: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FleetCommand = z.infer<typeof FleetCommandSchema>

export const FleetRunStateSchema = z.enum(['running', 'completed', 'failed', 'cancelled'])
export type FleetRunState = z.infer<typeof FleetRunStateSchema>

/**
 * Per-host outcome.
 *
 * `failed` means the command ran and exited non-zero. `unreachable` means it
 * never ran at all. Collapsing those two is how a fleet tool ends up
 * reporting a down server as a failed deploy.
 */
export const FleetHostStateSchema = z.enum([
  'pending',
  'connecting',
  'running',
  'succeeded',
  'failed',
  'unreachable',
  'timeout',
  'cancelled',
  'skipped',
])
export type FleetHostState = z.infer<typeof FleetHostStateSchema>

/** States a host will never leave on its own. */
export const FLEET_TERMINAL_HOST_STATES: readonly FleetHostState[] = [
  'succeeded',
  'failed',
  'unreachable',
  'timeout',
  'cancelled',
  'skipped',
]

export const FleetHostResultSchema = z.object({
  runId: z.string().min(1),
  connectionId: z.string().min(1),
  /** Denormalised so a run reads correctly after the connection is renamed or deleted. */
  connectionName: z.string().min(1),
  host: z.string().min(1),
  state: FleetHostStateSchema.default('pending'),
  exitCode: z.number().int().nullable().default(null),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  /** One line, for the summary table. Null on success. */
  errorSummary: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
})
export type FleetHostResult = z.infer<typeof FleetHostResultSchema>

export const FleetRunSchema = z.object({
  id: z.string().min(1),
  /** The saved command this came from, when it came from one. */
  commandId: z.string().min(1).nullable().default(null),
  /** What to call this run in a list. A command name, or a truncated script. */
  label: z.string().min(1),
  script: z.string().min(1),
  interpreter: FleetInterpreterSchema.default('sh'),
  sudo: z.boolean().default(false),
  workingDirectory: z.string().min(1).nullable().default(null),
  timeoutSeconds: z.number().int().positive().default(FLEET_DEFAULT_TIMEOUT_SECONDS),
  concurrency: z.number().int().positive().default(FLEET_DEFAULT_CONCURRENCY),
  onFailure: FleetFailureModeSchema.default('continue'),
  /** The selector as typed, kept so a run can be repeated against today's fleet. */
  targetSelector: z.array(z.string()).default([]),
  state: FleetRunStateSchema.default('running'),
  hostsTotal: z.number().int().nonnegative().default(0),
  hostsSucceeded: z.number().int().nonnegative().default(0),
  hostsFailed: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
})
export type FleetRun = z.infer<typeof FleetRunSchema>

/** The package managers the upgrade recipes know how to drive. */
export const PackageManagerSchema = z.enum(['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'brew', 'pkg', 'unknown'])
export type PackageManager = z.infer<typeof PackageManagerSchema>

/**
 * What a host reported when asked what it needs.
 *
 * `securityUpdates` is null where the package manager cannot separate
 * security updates from the rest, which is most of them. Null and zero mean
 * very different things here and are kept apart deliberately.
 */
export const HostUpdateReportSchema = z.object({
  connectionId: z.string().min(1),
  connectionName: z.string().min(1),
  host: z.string().min(1),
  reachable: z.boolean(),
  packageManager: PackageManagerSchema.default('unknown'),
  os: z.string().nullable().default(null),
  kernel: z.string().nullable().default(null),
  uptimeSeconds: z.number().nonnegative().nullable().default(null),
  updates: z.number().int().nonnegative().nullable().default(null),
  securityUpdates: z.number().int().nonnegative().nullable().default(null),
  rebootRequired: z.boolean().nullable().default(null),
  /** Root filesystem use, 0-100. Low disk is the usual reason an upgrade fails. */
  diskUsedPercent: z.number().min(0).max(100).nullable().default(null),
  error: z.string().nullable().default(null),
})
export type HostUpdateReport = z.infer<typeof HostUpdateReportSchema>

/**
 * Streaming events from a fleet run.
 *
 * Output arrives per line and per host rather than as a final blob, so a
 * fifteen-minute `apt upgrade` on eight servers is watchable while it happens.
 */
export type FleetEvent =
  | {
      type: 'run-start'
      runId: string
      hosts: readonly { connectionId: string; connectionName: string; host: string }[]
      /** Exactly what will be executed remotely, for the record and for --print-command. */
      command: string
    }
  | { type: 'host-start'; connectionId: string }
  | { type: 'host-stdout'; connectionId: string; line: string }
  | { type: 'host-stderr'; connectionId: string; line: string }
  | { type: 'host-exit'; connectionId: string; result: FleetHostResult }
  | {
      type: 'run-exit'
      runId: string
      state: FleetRunState
      succeeded: number
      failed: number
      skipped: number
    }
