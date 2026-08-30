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
  /**
   * A fleet run did not succeed everywhere.
   *
   * Deliberately one code rather than the failing host's own exit status:
   * across twelve servers there may be several, and picking one to pass
   * through would mean inventing a winner. `--json` carries every host's real
   * code for anything that needs them.
   */
  fleetIncomplete: 71,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT] | number
