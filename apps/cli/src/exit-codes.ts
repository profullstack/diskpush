/**
 * Exit codes.
 *
 * When rsync ran, its own exit code is what the caller sees, so existing
 * scripts that check for 23 or 24 keep working. DiskPush's own failures use a
 * band above anything rsync produces (its highest documented code is 35).
 */
export const EXIT = {
  ok: 0,
  /** Bad command line. */
  usage: 64,
  /** A named connection, profile or path does not exist. */
  configuration: 65,
  /** DiskPush declined: unconfirmed mirror, blocked pass-through argument. */
  refused: 66,
  /** A precondition failed: rsync missing, host unreachable. */
  unavailable: 69,
  /** DiskPush itself broke. */
  internal: 70,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT] | number
