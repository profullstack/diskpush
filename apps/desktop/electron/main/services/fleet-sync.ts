import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { runPlan } from '@diskpush/rsync-core'
import { IPC, type FleetSyncRequest, type TransferRequest } from '../../shared/contract.js'
import { isS3Connection } from '@diskpush/schemas'
import { resolveConnection } from './connections.js'
import { buildPlan } from './transfers.js'

/**
 * Fleet sync — push one source path out to many hosts at once.
 *
 * Each destination is a normal transfer (server-to-server when the source is an
 * SSH host, local-to-remote when it is this machine), so this is pure
 * orchestration: build a plan per destination, run them with bounded
 * concurrency, and stream each one's rsync events tagged with its connection id.
 * The renderer renders a row per destination from that stream. Nothing about how
 * a transfer runs lives here — it is reused wholesale from the transfer path.
 */

type RunningSync = { cancels: Map<string, () => void> }
const running = new Map<string, RunningSync>()

export type StartedFleetSync = { syncId: string; destinations: string[] }

export async function startFleetSync(request: FleetSyncRequest, sender: WebContents): Promise<StartedFleetSync> {
  const syncId = randomUUID()
  const cancels = new Map<string, () => void>()
  running.set(syncId, { cancels })

  const dests = [...request.destinationConnectionIds]
  const emit = (connectionId: string | null, event: unknown) => {
    if (!sender.isDestroyed()) sender.send(IPC.eventFleetSync, { syncId, connectionId, event })
  }

  const runOne = async (destId: string): Promise<void> => {
    const req: TransferRequest = {
      source: request.source,
      destination: { type: 'ssh', connectionId: destId, path: request.destinationPath },
      options: request.options,
      deletesConfirmed: false,
      selection: [],
    }
    let cleanup: () => Promise<void> = async () => {}
    emit(destId, { type: 'begin' })
    try {
      // The picker only offers servers, but the ids come from the renderer.
      // A bucket is not a fleet host: refuse it on its own row.
      const target = await resolveConnection(destId)
      if (isS3Connection(target)) throw new Error(`${target.name} is an S3 bucket; Fleet Sync pushes to servers.`)
      // The same path rarely exists on every host already: create it (--mkpath,
      // dropped with a warning by the planner when either rsync is older than 3.2.3).
      const built = await buildPlan(req, { mkpath: true })
      cleanup = built.cleanup
      const handle = runPlan(built.plan)
      cancels.set(destId, handle.cancel)
      for await (const event of handle.events) emit(destId, event)
    } catch (error) {
      // A per-destination failure never takes the fan-out down; it is reported
      // on that destination's row and the others carry on.
      emit(destId, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      cancels.delete(destId)
      await cleanup()
    }
  }

  // Bounded concurrency: a worker pool draining the destination queue.
  void (async () => {
    const queue = [...dests]
    const worker = async (): Promise<void> => {
      for (;;) {
        const destId = queue.shift()
        if (destId === undefined) return
        await runOne(destId)
      }
    }
    const width = Math.max(1, Math.min(request.concurrency, dests.length))
    await Promise.all(Array.from({ length: width }, () => worker()))
    running.delete(syncId)
    emit(null, { type: 'done' })
  })()

  return { syncId, destinations: dests }
}

export function cancelFleetSync(syncId: string): boolean {
  const entry = running.get(syncId)
  if (!entry) return false
  for (const cancel of entry.cancels.values()) cancel()
  return true
}
