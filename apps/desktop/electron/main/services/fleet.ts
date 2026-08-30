import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  BUILTIN_RECIPES,
  checkFleet,
  inspectScript,
  runFleet,
  type Hazard,
  type SudoMode,
} from '@diskpush/fleet-core'
import type { Connection, FleetCommand, FleetHostResult, FleetList, HostUpdateReport } from '@diskpush/schemas'
import { sshConfigConnections } from '@diskpush/ssh-core'
import { IPC, type FleetRequest } from '../../shared/contract.js'
import { dropSession, sessionFor } from './sessions.js'
import { store } from './store.js'

/**
 * Fleet operations for the desktop.
 *
 * The renderer sends connection ids and script text. Everything that turns
 * those into something a server executes — the interpreter, the sudo mode,
 * the host lookup, the hazard check — happens here, so the dialog is a view
 * of the operation rather than the thing that defines it.
 */

type RunningFleet = { runId: string; controller: AbortController }
const running = new Map<string, RunningFleet>()

/** Saved connections plus ~/.ssh/config hosts, saved winning a name clash. */
export async function fleetServers(): Promise<Connection[]> {
  const saved = await (await store()).listConnections()
  const savedNames = new Set(saved.map((connection) => connection.name))
  return [...saved, ...sshConfigConnections().filter((host) => !savedNames.has(host.name))]
}

export async function fleetCommands(): Promise<FleetCommand[]> {
  return (await store()).listFleetCommands(BUILTIN_RECIPES)
}

/**
 * Resolves ids to real connections.
 *
 * An id the renderer no longer has a server for is an error rather than a
 * silently smaller fleet — the same rule the CLI applies to a typo'd
 * selector, and for the same reason.
 */
async function connectionsFor(ids: readonly string[]): Promise<Connection[]> {
  const available = await fleetServers()
  const byId = new Map(available.map((connection) => [connection.id, connection]))
  const resolved: Connection[] = []
  for (const id of ids) {
    const connection = byId.get(id)
    if (!connection) throw new Error('One of the selected servers no longer exists. Close and reopen Fleet.')
    resolved.push(connection)
  }
  return resolved
}

export type FleetPreview = {
  servers: { id: string; name: string; host: string }[]
  hazards: Hazard[]
  /** The readable form of what will run. Not the runnable one. */
  command: string
}

/** What the dialog shows before anything runs. */
export async function previewFleet(request: FleetRequest): Promise<FleetPreview> {
  const connections = await connectionsFor(request.connectionIds)
  return {
    servers: connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      host: connection.host,
    })),
    hazards: inspectScript(request.script),
    command: request.script,
  }
}

export type StartedFleetRun = { runId: string; hosts: { connectionId: string; connectionName: string }[] }

export async function startFleet(request: FleetRequest, sender: WebContents): Promise<StartedFleetRun> {
  const connections = await connectionsFor(request.connectionIds)

  // Re-checked here, not taken on the renderer's word. The dialog showing a
  // confirmation is what makes this true; a renderer that skipped the dialog
  // must not be able to skip the check with it.
  const hazards = inspectScript(request.script)
  if (hazards.length > 0 && !request.hazardsConfirmed) {
    throw new Error(
      `This command matches ${hazards.length} destructive pattern(s) and was not confirmed: ` +
        hazards.map((hazard) => `line ${hazard.lineNumber}, ${hazard.explanation}`).join('; '),
    )
  }

  const sudo: SudoMode = !request.sudo ? 'off' : request.sudoPassword ? 'password' : 'non-interactive'
  const runId = randomUUID()
  const db = await store()

  await db.createFleetRun({
    id: runId,
    commandId: request.commandId,
    label: request.label,
    script: request.script,
    interpreter: request.interpreter,
    sudo: request.sudo,
    workingDirectory: request.workingDirectory,
    timeoutSeconds: request.timeoutSeconds,
    concurrency: request.concurrency,
    onFailure: request.onFailure,
    targetSelector: connections.map((connection) => connection.name),
    state: 'running',
    hostsTotal: connections.length,
    hostsSucceeded: 0,
    hostsFailed: 0,
    completedAt: null,
  })

  const controller = new AbortController()
  running.set(runId, { runId, controller })

  void (async () => {
    try {
      const run = await runFleet({
        connections,
        script: request.script,
        interpreter: request.interpreter,
        sudo,
        ...(request.sudoPassword ? { sudoPassword: request.sudoPassword } : {}),
        workingDirectory: request.workingDirectory,
        timeoutSeconds: request.timeoutSeconds,
        concurrency: request.concurrency,
        onFailure: request.onFailure,
        runId,
        signal: controller.signal,
        connect: (connection) => sessionFor(connection),
        // No release: the desktop pools sessions across browsing and
        // transfers, so closing one here would shut a file pane's connection
        // out from under it.
        onEvent: (event) => {
          // The window can go away mid-run. The run carries on and its
          // outcome is still recorded, the same as a transfer.
          if (!sender.isDestroyed()) sender.send(IPC.eventFleet, { runId, event })
        },
      })

      for (const result of run.results) await db.saveFleetHostResult(result)
      await db.completeFleetRun(runId, {
        state: run.state,
        hostsSucceeded: run.succeeded,
        hostsFailed: run.failed,
      })
    } catch (error) {
      await db.completeFleetRun(runId, { state: 'failed', hostsSucceeded: 0, hostsFailed: connections.length })
      if (!sender.isDestroyed()) {
        sender.send(IPC.eventFleet, {
          runId,
          event: { type: 'run-error', message: error instanceof Error ? error.message : String(error) },
        })
      }
    } finally {
      running.delete(runId)
      // A command that changed sshd, the login shell or a key would leave a
      // pooled session pointing at a server that no longer works the way the
      // session assumes. Cheaper to reconnect than to debug that later.
      if (request.sudo) for (const connection of connections) dropSession(connection.id)
    }
  })()

  return {
    runId,
    hosts: connections.map((connection) => ({ connectionId: connection.id, connectionName: connection.name })),
  }
}

// --- saved commands ---------------------------------------------------------

/**
 * Saves a command from the Fleet view.
 *
 * `builtin` is not settable here: the store forces it false, so a saved
 * command can shadow a shipped recipe by name but can never claim to be one.
 */
export async function saveFleetCommand(input: {
  name: string
  description: string
  script: string
  interpreter: 'sh' | 'bash' | 'raw'
  sudo: boolean
  workingDirectory: string | null
  timeoutSeconds: number
  concurrency: number
  onFailure: 'continue' | 'stop'
  targets: string[]
}): Promise<FleetCommand> {
  return (await store()).saveFleetCommand({ ...input, tags: [] })
}

export async function removeFleetCommand(name: string): Promise<boolean> {
  if (BUILTIN_RECIPES.some((recipe) => recipe.name === name)) {
    throw new Error(`${name} is a recipe DiskPush ships and cannot be deleted. Save a copy under another name instead.`)
  }
  return (await store()).deleteFleetCommand(name)
}

// --- saved lists ------------------------------------------------------------

export async function fleetLists(): Promise<FleetList[]> {
  return (await store()).listFleetLists()
}

/**
 * Saves the ticked servers as a named list.
 *
 * The ids are resolved here and each member's *current* name stored beside it,
 * so the list can still name a member after that connection is gone.
 */
export async function saveFleetList(input: {
  name: string
  description: string
  connectionIds: readonly string[]
}): Promise<FleetList> {
  const connections = await connectionsFor(input.connectionIds)
  return (await store()).saveFleetList({
    name: input.name,
    description: input.description,
    members: connections.map((connection) => ({
      connectionId: connection.id,
      connectionName: connection.name,
    })),
  })
}

export async function renameFleetList(from: string, to: string): Promise<FleetList> {
  const renamed = await (await store()).renameFleetList(from, to)
  if (!renamed) throw new Error(`No saved list named ${JSON.stringify(from)}.`)
  return renamed
}

export async function removeFleetList(name: string): Promise<boolean> {
  return (await store()).deleteFleetList(name)
}

export function cancelFleet(runId: string): boolean {
  const run = running.get(runId)
  if (!run) return false
  run.controller.abort()
  return true
}

export async function checkFleetServers(input: {
  connectionIds: readonly string[]
  concurrency: number
  timeoutSeconds: number
}): Promise<HostUpdateReport[]> {
  const connections = await connectionsFor(input.connectionIds)
  const { reports } = await checkFleet({
    connections,
    concurrency: input.concurrency,
    timeoutSeconds: input.timeoutSeconds,
    connect: (connection) => sessionFor(connection),
  })
  return reports
}

export async function fleetRunDetail(runId: string): Promise<{ run: unknown; hosts: FleetHostResult[] } | null> {
  const db = await store()
  const run = await db.findFleetRun(runId)
  if (!run) return null
  return { run, hosts: await db.listFleetRunHosts(run.id) }
}

/** True while any fleet command is in flight; the updater defers a restart on it. */
export function hasActiveFleetRun(): boolean {
  return running.size > 0
}

export function cancelAllFleetRuns(): void {
  for (const run of running.values()) run.controller.abort()
}
