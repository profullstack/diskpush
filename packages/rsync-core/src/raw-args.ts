/**
 * Analysis of the verbatim rsync arguments a user supplied after `--`.
 *
 * Pass-through is a feature, not a hole: the tokens are never re-parsed by a
 * shell and never rewritten. But a few of them change what a job *is* -
 * turning a sync into a mirror, or a copy into a move - and those must not
 * slip past the confirmation the equivalent DiskPush option would have
 * triggered.
 */

export type RawArgIssue = {
  arg: string
  severity: 'blocked' | 'conflict'
  /**
   * What the flag does. Only `destination-delete` can be waived, and only by a
   * confirmed mirror: nothing waives deleting the source.
   */
  kind: 'destination-delete' | 'source-delete' | 'transport'
  reason: string
}

/** Flags that delete data at the destination. */
const DELETE_FLAGS = new Set([
  '--delete',
  '--delete-before',
  '--delete-during',
  '--del',
  '--delete-delay',
  '--delete-after',
  '--delete-excluded',
  '--delete-missing-args',
])

/** Flags that delete data at the *source*. */
const SOURCE_DESTRUCTIVE_FLAGS = new Set(['--remove-source-files', '--remove-sent-files'])

/** Flags that would hijack the transport DiskPush established. */
const TRANSPORT_FLAGS = new Set(['-e', '--rsh', '--daemon', '--rsync-path', '--config', '--password-file'])

function flagName(arg: string): string {
  const equals = arg.indexOf('=')
  return equals === -1 ? arg : arg.slice(0, equals)
}

/** `-avz` style bundles: expand so `-e` hidden inside one is still seen. */
function shortFlags(arg: string): string[] {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length < 2) return []
  return [...arg.slice(1)].map((c) => `-${c}`)
}

export type RawArgAnalysis = {
  issues: RawArgIssue[]
  /** True when the raw args ask for destination deletion. */
  requestsDelete: boolean
  /** True when the raw args ask rsync to delete source files after sending. */
  requestsSourceRemoval: boolean
  /** True when the raw args would replace the SSH transport DiskPush built. */
  overridesTransport: boolean
}

export function analyzeRawArgs(rawArgs: readonly string[]): RawArgAnalysis {
  const issues: RawArgIssue[] = []
  let requestsDelete = false
  let requestsSourceRemoval = false
  let overridesTransport = false

  for (const arg of rawArgs) {
    const name = flagName(arg)
    const candidates = [name, ...shortFlags(name)]

    for (const candidate of candidates) {
      if (DELETE_FLAGS.has(candidate)) {
        requestsDelete = true
        issues.push({
          arg,
          severity: 'blocked',
          kind: 'destination-delete',
          reason:
            `${candidate} deletes files at the destination. Enable Mirror mode (CLI: \`diskpush mirror\`) ` +
            'so the delete list is previewed and confirmed first.',
        })
      }
      if (SOURCE_DESTRUCTIVE_FLAGS.has(candidate)) {
        requestsSourceRemoval = true
        issues.push({
          arg,
          severity: 'blocked',
          kind: 'source-delete',
          reason: `${candidate} deletes files from the source after transfer. DiskPush does not move files.`,
        })
      }
      if (TRANSPORT_FLAGS.has(candidate)) {
        overridesTransport = true
        issues.push({
          arg,
          severity: 'conflict',
          kind: 'transport',
          reason:
            `${candidate} replaces the SSH transport DiskPush configured for this connection. ` +
            'Set it on the connection instead.',
        })
      }
    }
  }

  return { issues, requestsDelete, requestsSourceRemoval, overridesTransport }
}
