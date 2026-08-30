import { HostUpdateReportSchema, type Connection, type FleetEvent, type HostUpdateReport } from '@diskpush/schemas'
import { runFleet, type ConnectFn, type ReleaseFn } from './runner.js'
import { CHECK_SCRIPT, parseCheckOutput } from './upgrade.js'

/**
 * The read-only sweep: ask every server what it needs, install nothing.
 *
 * Built on `runFleet` rather than beside it, so the check gets the same
 * bounded concurrency, the same timeout handling and the same reachable /
 * failed distinction as everything else — and so there is one place where a
 * fleet of servers is walked.
 */

export type FleetCheckOptions = {
  connections: readonly Connection[]
  connect: ConnectFn
  release?: ReleaseFn
  concurrency?: number
  /** Short by default: this only reads state, and a server that cannot answer in a minute is the finding. */
  timeoutSeconds?: number
  onEvent?: (event: FleetEvent) => void
  signal?: AbortSignal
}

export type FleetCheckResult = {
  reports: HostUpdateReport[]
  /** Hosts that answered at all. The rest carry an `error` and `reachable: false`. */
  reachable: number
  unreachable: number
}

export async function checkFleet(options: FleetCheckOptions): Promise<FleetCheckResult> {
  const run = await runFleet({
    connections: options.connections,
    script: CHECK_SCRIPT,
    interpreter: 'sh',
    // Deliberately unprivileged. Reading what is pending needs no root on any
    // supported package manager, and a status command that asks for sudo is a
    // status command people stop running.
    sudo: 'off',
    // A probe is not a sequence of steps. `grep -c` exits 1 when it counts
    // zero updates, and under `-e` that ends the script and reports a
    // perfectly healthy, fully patched server as unreachable.
    failFast: false,
    timeoutSeconds: options.timeoutSeconds ?? 180,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    connect: options.connect,
    ...(options.release ? { release: options.release } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const byId = new Map(options.connections.map((connection) => [connection.id, connection]))
  const reports = run.results.map((result) => {
    const connection = byId.get(result.connectionId)
    const base = {
      connectionId: result.connectionId,
      connectionName: result.connectionName,
      host: connection?.host ?? result.host,
    }

    if (result.state !== 'succeeded') {
      return HostUpdateReportSchema.parse({
        ...base,
        reachable: false,
        error: result.errorSummary ?? `The check did not complete (${result.state}).`,
      })
    }

    return HostUpdateReportSchema.parse({
      ...base,
      reachable: true,
      ...parseCheckOutput(result.stdout),
      error: null,
    })
  })

  return {
    reports,
    reachable: reports.filter((report) => report.reachable).length,
    unreachable: reports.filter((report) => !report.reachable).length,
  }
}

/** Servers with something pending, worst first. For "what should I do tonight". */
export function needsAttention(reports: readonly HostUpdateReport[]): HostUpdateReport[] {
  return reports
    .filter((report) => !report.reachable || (report.updates ?? 0) > 0 || report.rebootRequired === true)
    .sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? 1 : -1
      return (b.securityUpdates ?? 0) - (a.securityUpdates ?? 0) || (b.updates ?? 0) - (a.updates ?? 0)
    })
}
