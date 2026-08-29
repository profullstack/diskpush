import { topologyOf, type Endpoint, type RsyncOptions, type TransferTopology } from '@diskpush/schemas'
import { buildRsyncArgs, renderCommand, RsyncArgError, type BuildArgsInput } from './args.js'
import { buildRemoteShellTokens, renderRemoteShell, type RemoteShellOptions } from './remote-shell.js'
import { shellJoin } from './shell-quote.js'
import type { RsyncCapabilities } from './version.js'

/**
 * A fully resolved, ready-to-spawn command.
 *
 * `binary` + `args` are passed to spawn with `shell: false`. `display` is for
 * humans and logs and is never executed.
 */
export type ExecutionPlan = {
  binary: string
  args: string[]
  /** The rsync argv itself; for server-to-server this runs on the source host. */
  rsyncArgs: string[]
  topology: TransferTopology
  display: string
  /** Present only for server-to-server: how DiskPush reaches the source host. */
  controlDisplay?: string
  warnings: string[]
  /** True when file payload never touches this machine. */
  direct: boolean
}

export type TransferPlanInput = {
  source: Endpoint
  destination: Endpoint
  options: RsyncOptions
  capabilities?: RsyncCapabilities
  deletesConfirmed?: boolean
  /** SSH transport for the remote endpoint of a local<->remote transfer. */
  remoteShell?: RemoteShellOptions
  /** SSH transport DiskPush uses to reach the source host (server-to-server only). */
  sourceShell?: RemoteShellOptions
  /** SSH transport the source host uses to reach the destination host. */
  destinationShell?: RemoteShellOptions
  /** Remote rsync binary on the source host, when it is not `rsync` on PATH. */
  sourceRsyncPath?: string | null
}

export function planTransfer(input: TransferPlanInput): ExecutionPlan {
  const topology = topologyOf(input.source, input.destination)
  if (topology === 'remote-to-remote') return planServerToServer(input)
  return planDirect(input, topology)
}

function planDirect(input: TransferPlanInput, topology: TransferTopology): ExecutionPlan {
  const remoteEndpoint = input.source.type === 'ssh' ? input.source : input.destination.type === 'ssh' ? input.destination : null

  const buildInput: BuildArgsInput = {
    source: input.source,
    destination: input.destination,
    options: input.options,
    deletesConfirmed: input.deletesConfirmed ?? false,
  }
  if (input.capabilities) buildInput.capabilities = input.capabilities
  if (remoteEndpoint) {
    buildInput.remoteShell = buildRemoteShellTokens({
      port: remoteEndpoint.port ?? null,
      ...input.remoteShell,
    })
  }

  const built = buildRsyncArgs(buildInput)
  return {
    binary: 'rsync',
    args: built.args,
    rsyncArgs: built.args,
    topology,
    display: renderCommand(built.args),
    warnings: built.warnings,
    direct: true,
  }
}

/**
 * Server-to-server: rsync runs *on the source host* and connects straight to
 * the destination host. DiskPush holds an SSH session to the source for
 * control and output only; no file payload passes through this machine.
 */
function planServerToServer(input: TransferPlanInput): ExecutionPlan {
  if (input.source.type !== 'ssh' || input.destination.type !== 'ssh') {
    throw new RsyncArgError('planServerToServer requires two SSH endpoints.')
  }

  // From the source host's point of view its own path is local.
  const buildInput: BuildArgsInput = {
    source: { type: 'local', path: input.source.path },
    destination: input.destination,
    options: input.options,
    deletesConfirmed: input.deletesConfirmed ?? false,
    remoteShell: buildRemoteShellTokens({
      port: input.destination.port ?? null,
      ...input.destinationShell,
    }),
  }
  if (input.capabilities) buildInput.capabilities = input.capabilities

  const built = buildRsyncArgs(buildInput)
  const rsyncBinary = input.sourceRsyncPath ?? 'rsync'
  const remoteCommand = [rsyncBinary, ...built.args]

  const controlTokens = buildRemoteShellTokens({
    port: input.source.port ?? null,
    ...input.sourceShell,
  })
  // Drop the leading `ssh`: we are building ssh's own argv, not rsync's -e string.
  const sshOptions = controlTokens.slice(1)
  const target = input.source.user ? `${input.source.user}@${input.source.host}` : input.source.host

  // `ssh host cmd...` always runs the command through the remote login shell,
  // joining argv with spaces. That shell is unavoidable, so the tokens are
  // quoted for it here and passed as one argv element.
  const args = [...sshOptions, target, shellJoin(remoteCommand)]

  return {
    binary: 'ssh',
    args,
    rsyncArgs: built.args,
    topology: 'remote-to-remote',
    display: renderCommand(built.args, rsyncBinary),
    controlDisplay: `ssh ${sshOptions.join(' ')} ${target}`.replace(/\s+/g, ' ').trim(),
    warnings: built.warnings,
    direct: true,
  }
}

export { renderRemoteShell }
