import { involvesS3, renderS3Endpoint, topologyOf, type Endpoint, type RsyncOptions, type TransferTopology } from '@diskpush/schemas'
import type { S3Client, S3SyncSpec } from '@diskpush/s3-core'
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
  /** Which engine runs it. Absent means rsync. */
  engine?: 'rsync' | 's3'
  /** For the S3 engine: everything it needs, credentials included. Never stored or logged. */
  s3?: S3SyncSpec
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
  /** The client for the S3 side of a local<->S3 transfer. */
  s3Client?: S3Client
}

export function planTransfer(input: TransferPlanInput): ExecutionPlan {
  const topology = topologyOf(input.source, input.destination)
  if (involvesS3(input.source, input.destination)) return planS3(input, topology)
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
 * Local <-> S3, on DiskPush's own S3 engine. A server <-> bucket transfer
 * would have to relay every byte through this machine or depend on a tool
 * on the server, so it is refused with what to do instead.
 */
function planS3(input: TransferPlanInput, topology: TransferTopology): ExecutionPlan {
  const { source, destination, options } = input
  if (source.type !== 'local' && destination.type !== 'local') {
    throw new RsyncArgError(
      'S3 transfers run between this machine and a bucket. To move files between a server and a bucket, sync them down first, or run DiskPush on the server.',
    )
  }
  if (!input.s3Client) throw new RsyncArgError('An S3 endpoint was given but no S3 client was configured for it.')
  if (options.deleteMode !== 'off' && !options.dryRun && !input.deletesConfirmed) {
    throw new RsyncArgError(
      'Mirror mode deletes destination files. Run the dry-run preview and confirm the delete list before building a live mirror job.',
    )
  }
  const upload = destination.type === 's3'
  const bucketSide = (upload ? destination : source) as Extract<Endpoint, { type: 's3' }>
  const localSide = (upload ? source : destination) as Extract<Endpoint, { type: 'local' }>
  const warnings: string[] = []
  if (options.rawArgs.length) warnings.push('Pass-through rsync arguments do not apply to an S3 transfer and were ignored.')
  if (options.acls || options.xattrs || options.hardLinks) warnings.push('ACLs, extended attributes and hard links cannot be stored in S3 and were not copied.')
  const spec: S3SyncSpec = {
    direction: upload ? 'upload' : 'download',
    client: input.s3Client,
    local: localSide.path,
    remote: bucketSide.path,
    options: {
      deleteMode: options.deleteMode,
      dryRun: options.dryRun,
      excludes: options.excludes,
      includes: options.includes,
      filesFrom: options.filesFrom,
      from0: options.from0,
      checksum: options.checksum,
      update: options.update,
      ignoreExisting: options.ignoreExisting,
      existingOnly: options.existingOnly,
      itemizeAll: options.itemizeAll,
      maxSize: options.maxSize,
      minSize: options.minSize,
    },
    deletesConfirmed: input.deletesConfirmed ?? false,
  }
  const flags = [options.dryRun ? '--dry-run' : '', options.deleteMode !== 'off' ? '--delete' : '', options.checksum ? '--checksum' : '']
    .filter(Boolean)
    .join(' ')
  const remote = renderS3Endpoint(bucketSide)
  const display = `diskpush s3 sync ${flags ? `${flags} ` : ''}${upload ? `${localSide.path} ${remote}` : `${remote} ${localSide.path}`}`
  return { binary: 's3', args: [], rsyncArgs: [], topology, display, warnings, direct: true, engine: 's3', s3: spec }
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
