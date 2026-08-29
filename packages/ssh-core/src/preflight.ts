import { shellQuote, type RsyncCapabilities } from '@diskpush/rsync-core'
import type { SshEndpoint } from '@diskpush/schemas'
import { probeConnection, type ConnectionReport } from './capabilities.js'
import type { SshSession } from './session.js'

/**
 * Preflight for a direct server-to-server job.
 *
 * The point of these checks is to fail before anything starts, with a
 * specific reason, rather than half-way through with an opaque rsync error.
 * DiskPush never silently falls back to relaying bytes through this machine.
 */

export type PreflightCheck = {
  id: string
  label: string
  ok: boolean
  detail: string
}

export type PreflightResult = {
  checks: PreflightCheck[]
  ok: boolean
  sourceReport: ConnectionReport | null
  destinationCapabilities: RsyncCapabilities | null
}

export type PreflightOptions = {
  /** How the source host should address the destination, e.g. `user@backup-02`. */
  destinationTarget: string
  destinationPort?: number | null
  sourceRsyncPath?: string | null
  destinationRsyncPath?: string | null
  /** Verify the destination directory exists and is writable. */
  destinationPath: string
}

function check(id: string, label: string, ok: boolean, detail: string): PreflightCheck {
  return { id, label, ok, detail }
}

export async function preflightServerToServer(
  sourceSession: SshSession,
  source: SshEndpoint,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []

  // 1. DiskPush -> Server A is already proven: we hold the session.
  checks.push(check('control', `DiskPush → ${source.host}`, true, 'SSH control session established.'))

  // 2. rsync on Server A.
  const sourceReport = await probeConnection(sourceSession, options.sourceRsyncPath ?? null)
  checks.push(
    check(
      'source-rsync',
      `rsync on ${source.host}`,
      sourceReport.rsync,
      sourceReport.rsync ? (sourceReport.rsyncVersion ?? 'present') : 'rsync is not installed on the source host.',
    ),
  )
  if (!sourceReport.rsync) {
    return { checks, ok: false, sourceReport, destinationCapabilities: null }
  }

  // 3. Server A -> Server B: reachability and authentication in one step.
  //    BatchMode makes a missing key fail immediately instead of prompting
  //    into a hung session.
  const sshPrefix = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    ...(options.destinationPort && options.destinationPort !== 22 ? ['-p', String(options.destinationPort)] : []),
  ]
    .map(shellQuote)
    .join(' ')

  const auth = await sourceSession.exec(`${sshPrefix} ${shellQuote(options.destinationTarget)} true`)
  const authOk = auth.code === 0
  checks.push(
    check(
      'hop',
      `${source.host} → ${options.destinationTarget}`,
      authOk,
      authOk
        ? 'The source host can reach and authenticate to the destination.'
        : summarizeHopFailure(auth.stderr, source.host, options.destinationTarget),
    ),
  )
  if (!authOk) return { checks, ok: false, sourceReport, destinationCapabilities: null }

  // 4. rsync on Server B, asked from Server A so it reflects the real path.
  const destinationBinary = options.destinationRsyncPath ?? 'rsync'
  const remoteVersion = await sourceSession.exec(
    `${sshPrefix} ${shellQuote(options.destinationTarget)} ${shellQuote(destinationBinary)} --version`,
  )
  const destinationHasRsync = remoteVersion.code === 0 && /rsync\s+version/i.test(remoteVersion.stdout)
  const { parseRsyncCapabilities } = await import('@diskpush/rsync-core')
  const destinationCapabilities = destinationHasRsync ? parseRsyncCapabilities(remoteVersion.stdout) : null
  checks.push(
    check(
      'destination-rsync',
      `rsync on ${options.destinationTarget}`,
      destinationHasRsync,
      destinationHasRsync
        ? (destinationCapabilities?.version?.raw ?? 'present')
        : 'rsync is not installed on the destination host.',
    ),
  )

  // 5. Destination path exists and is writable.
  const writable = await sourceSession.exec(
    `${sshPrefix} ${shellQuote(options.destinationTarget)} test -d ${shellQuote(options.destinationPath)} ` +
      `-a -w ${shellQuote(options.destinationPath)}`,
  )
  const destinationWritable = writable.code === 0
  checks.push(
    check(
      'destination-writable',
      'Destination writable',
      destinationWritable,
      destinationWritable
        ? `${options.destinationPath} exists and is writable.`
        : `${options.destinationPath} does not exist or the remote user cannot write to it.`,
    ),
  )

  const ok = checks.every((c) => c.ok)
  checks.push(
    check(
      'direct',
      'Direct transfer available',
      ok,
      ok
        ? 'File payload will move directly between the two servers.'
        : 'Direct server-to-server transfer is unavailable. DiskPush will not relay the files instead.',
    ),
  )

  return { checks, ok, sourceReport, destinationCapabilities }
}

function summarizeHopFailure(stderr: string, from: string, to: string): string {
  if (/Permission denied|publickey/i.test(stderr)) {
    return `${from} reached ${to} but could not authenticate. Authorise a key for ${to} on ${from}, or enable agent forwarding.`
  }
  if (/Could not resolve hostname/i.test(stderr)) return `${from} cannot resolve ${to}.`
  if (/Connection timed out|No route to host/i.test(stderr)) return `${from} cannot reach ${to} over the network.`
  if (/Host key verification failed/i.test(stderr)) return `${from} could not verify the host key for ${to}.`
  return stderr.trim() || `${from} could not connect to ${to}.`
}
