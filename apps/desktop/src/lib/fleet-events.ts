import type { FleetEvent, FleetHostState } from '@/lib/api'

/**
 * Folding a fleet event stream into what the dialog draws.
 *
 * Kept out of the component because it is the only part of the Fleet view
 * with a decision in it, and a reducer that decides how a run is reported is
 * worth testing without a browser.
 */

export type HostView = {
  connectionId: string
  name: string
  host: string
  state: FleetHostState
  lines: string[]
  exitCode: number | null
  errorSummary: string | null
  durationMs: number | null
}

/**
 * Live output kept per host.
 *
 * A full `apt upgrade` transcript across thirty servers is megabytes of DOM.
 * The oldest lines are dropped rather than the newest, because the reason a
 * host failed is at the end. The whole transcript is still recorded, and
 * `fleet show` prints it.
 */
export const MAX_LIVE_LINES = 400

export function blankHost(server: { id: string; name: string; host: string }): HostView {
  return {
    connectionId: server.id,
    name: server.name,
    host: server.host,
    state: 'pending',
    lines: [],
    exitCode: null,
    errorSummary: null,
    durationMs: null,
  }
}

export function foldHosts(hosts: readonly HostView[], event: FleetEvent): HostView[] {
  // Run-level events say nothing about any one host.
  if (event.type === 'run-start' || event.type === 'run-exit' || event.type === 'run-error') return [...hosts]

  return hosts.map((host) => {
    if (host.connectionId !== event.connectionId) return host
    switch (event.type) {
      case 'host-start':
        return { ...host, state: 'running' }
      case 'host-stdout':
      case 'host-stderr':
        return { ...host, lines: [...host.lines, event.line].slice(-MAX_LIVE_LINES) }
      case 'host-exit':
        return {
          ...host,
          state: event.result.state,
          exitCode: event.result.exitCode,
          errorSummary: event.result.errorSummary,
          durationMs: event.result.durationMs,
        }
      default:
        return host
    }
  })
}
