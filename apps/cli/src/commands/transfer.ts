import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { DiskPushStore } from '@diskpush/database'
import { capabilityCacheKey } from '../resolve.js'
import {
  RsyncArgError,
  intersectCapabilities,
  planTransfer,
  runPlan,
  summarizeChangesFrom,
  type ExecutionPlan,
} from './transfer-helpers.js'
import type { Change, RsyncOptions } from '@diskpush/schemas'
import { summarizeChanges, topologyOf } from '@diskpush/schemas'
import { EXIT } from '../exit-codes.js'
import { estimateRemaining, formatBytes, formatDuration, formatRate, pluralize, table } from '../format.js'
import { failure, type Output } from '../output.js'
import { flagValue, hasFlag, type ParsedArgv } from '../parse-argv.js'
import { detectLocalCapabilities, optionsFromFlags, resolveEndpoint } from '../resolve.js'
import type { RsyncCapabilities } from '@diskpush/rsync-core'

/** Commands that are the same safe engine with a different intent and preset. */
export const TRANSFER_ALIASES: Record<string, { deleteMode: RsyncOptions['deleteMode']; label: string }> = {
  sync: { deleteMode: 'off', label: 'Sync' },
  push: { deleteMode: 'off', label: 'Push' },
  pull: { deleteMode: 'off', label: 'Pull' },
  publish: { deleteMode: 'off', label: 'Publish' },
  deploy: { deleteMode: 'off', label: 'Deploy' },
  backup: { deleteMode: 'off', label: 'Backup' },
  mirror: { deleteMode: 'delay', label: 'Mirror' },
  rsync: { deleteMode: 'off', label: 'rsync' },
}

export async function runTransfer(
  command: string,
  parsed: ParsedArgv,
  store: DiskPushStore,
  output: Output,
): Promise<number> {
  const alias = TRANSFER_ALIASES[command] ?? TRANSFER_ALIASES.sync!
  const profileName = flagValue(parsed, '--profile')

  let sourceInput: string | undefined
  let destinationInput: string | undefined
  let options: RsyncOptions

  if (profileName) {
    const profile = await store.findProfile(profileName)
    if (!profile) return failure(output, `No sync profile named ${JSON.stringify(profileName)}.`, EXIT.configuration)
    options = optionsFromFlags(parsed, profile.options)
    sourceInput = parsed.positionals[0] ?? renderStored(profile.source)
    destinationInput = parsed.positionals[1] ?? renderStored(profile.destination)
  } else {
    ;[sourceInput, destinationInput] = parsed.positionals
    options = optionsFromFlags(parsed)
  }

  if (!sourceInput || !destinationInput) {
    return failure(output, `Usage: diskpush ${command} SOURCE DESTINATION [options] [-- rsync args]`, EXIT.usage)
  }

  if (alias.deleteMode !== 'off') options.deleteMode = alias.deleteMode

  const source = await resolveEndpoint(store, sourceInput)
  const destination = await resolveEndpoint(store, destinationInput)
  const topology = topologyOf(source.endpoint, destination.endpoint)

  const capabilities = await effectiveCapabilities(store, source, destination)

  const planInput = {
    source: source.endpoint,
    destination: destination.endpoint,
    options,
    capabilities,
    ...transportFor(source, destination, topology),
  }

  // --- preview ------------------------------------------------------------
  // Mirror always previews before it can run. A plain sync previews only when
  // asked, because its dry run costs a full scan for no safety benefit.
  const wantsPreview = options.deleteMode !== 'off' || options.dryRun
  let preview: Awaited<ReturnType<typeof runPreview>> | null = null

  if (wantsPreview) {
    try {
      preview = await runPreview(planInput, output)
    } catch (error) {
      return reportPlanError(error, output)
    }
    if (preview.exitCode !== 0) {
      return finish(output, preview.exitCode, preview.message, { phase: 'preview' })
    }
    renderPreview(preview.changes, output, options.deleteMode !== 'off')
  }

  if (options.dryRun) {
    return finish(output, EXIT.ok, 'Dry run complete. Nothing was transferred.', {
      dryRun: true,
      changes: preview ? summarizeChanges(preview.changes) : null,
      deletes: preview?.changes.filter((c) => c.action === 'delete').map((c) => c.path) ?? [],
    })
  }

  // --- confirmation --------------------------------------------------------
  let deletesConfirmed = false
  if (options.deleteMode !== 'off') {
    const deleteCount = preview?.changes.filter((c) => c.action === 'delete').length ?? 0
    if (deleteCount === 0) {
      deletesConfirmed = true
    } else if (hasFlag(parsed, '--yes')) {
      deletesConfirmed = true
    } else if (hasFlag(parsed, '--non-interactive') || !process.stdin.isTTY) {
      return failure(
        output,
        `Mirror would delete ${pluralize(deleteCount, 'file')} at the destination. ` +
          'Re-run with --yes to confirm, or without --non-interactive to be asked.',
        EXIT.refused,
        { deletes: preview?.changes.filter((c) => c.action === 'delete').map((c) => c.path) ?? [] },
      )
    } else {
      deletesConfirmed = await confirm(`Delete ${pluralize(deleteCount, 'file')} at the destination?`)
      if (!deletesConfirmed) return failure(output, 'Mirror cancelled. Nothing was deleted.', EXIT.refused)
    }
  }

  // --- run -----------------------------------------------------------------
  let plan: ExecutionPlan
  try {
    plan = planTransfer({ ...planInput, deletesConfirmed })
  } catch (error) {
    return reportPlanError(error, output)
  }

  if (hasFlag(parsed, '--print-args')) {
    output.line(plan.display)
    if (plan.controlDisplay) output.line(`# control session: ${plan.controlDisplay}`)
    if (output.isJson) output.json({ status: 'ok', command: plan.display, control: plan.controlDisplay ?? null, args: plan.rsyncArgs })
    return EXIT.ok
  }

  for (const warning of plan.warnings) output.warn(`warning: ${warning}`)

  const jobId = randomUUID()
  await store.createJob({
    id: jobId,
    profileId: null,
    source: source.endpoint,
    destination: destination.endpoint,
    options,
    state: 'running',
    bytesTotal: 0,
    bytesTransferred: 0,
    percent: 0,
    filesTransferred: 0,
    retryCount: 0,
    exitCode: null,
    errorSummary: null,
    logPath: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  })

  output.line(`DiskPush: ${alias.label} ${describe(sourceInput)} -> ${describe(destinationInput)}`)
  output.line(`Source:      ${sourceInput}`)
  output.line(`Destination: ${destinationInput}`)
  if (topology === 'remote-to-remote') {
    output.line('')
    output.line(`Direct path:    ${source.endpoint.type === 'ssh' ? source.endpoint.host : '?'} -> ${destination.endpoint.type === 'ssh' ? destination.endpoint.host : '?'}`)
    output.line('Desktop relay:  none')
    output.line('DiskPush relay: none')
  }
  output.line('')

  const changes: Change[] = []
  let lastProgress: import('@diskpush/schemas').RsyncProgress | null = null
  let exitCode: number = EXIT.internal
  let message = ''
  let resumable = false
  const stderr: string[] = []

  const handle = runPlan(plan)
  const stop = () => handle.cancel()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    for await (const event of handle.events) {
      switch (event.type) {
        case 'change':
          changes.push(event.change)
          break
        case 'progress': {
          lastProgress = event.progress
          const remaining = estimateRemaining(event.progress.percent, event.progress.elapsedSeconds)
          output.status(
            `  ${formatBytes(event.progress.bytesTransferred).padStart(10)}  ${String(event.progress.percent).padStart(3)}%  ` +
              `${formatRate(event.progress.bytesPerSecond).padStart(11)}  ` +
              `ETA ${remaining === null ? '--:--' : formatDuration(remaining)}`,
          )
          break
        }
        case 'stderr':
          stderr.push(event.line)
          break
        case 'exit':
          exitCode = event.code
          message = event.message
          resumable = event.resumable
          break
        default:
          break
      }
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    output.clearStatus()
  }

  const summary = summarizeChanges(changes)
  const ok = exitCode === 0 || exitCode === 24

  await store.updateJob(jobId, {
    state: ok ? 'completed' : resumable ? 'interrupted' : 'failed',
    exitCode,
    percent: lastProgress?.percent ?? (ok ? 100 : 0),
    bytesTransferred: lastProgress?.bytesTransferred ?? 0,
    filesTransferred: summary.add + summary.update,
    errorSummary: ok ? null : message,
    completedAt: new Date().toISOString(),
  })
  if (stderr.length > 0) await store.appendEvent(jobId, 'stderr', stderr.join('\n'))

  if (!ok) for (const line of stderr) output.error(line)

  output.line(
    `Changed: ${pluralize(summary.add + summary.update, 'file')}` +
      (summary.delete > 0 ? `   Deleted: ${pluralize(summary.delete, 'file')}` : ''),
  )
  if (lastProgress) {
    output.line(`Transferred: ${formatBytes(lastProgress.bytesTransferred)} in ${formatDuration(lastProgress.elapsedSeconds)}`)
  }
  output.line(message)

  if (output.isJson) {
    output.json({
      status: ok ? 'completed' : resumable ? 'interrupted' : 'failed',
      jobId,
      diskpushExitCode: 0,
      rsyncExitCode: exitCode,
      resumable,
      message,
      changes: summary,
      command: plan.display,
      control: plan.controlDisplay ?? null,
      direct: plan.direct,
    })
  }

  return exitCode
}

// --- helpers ---------------------------------------------------------------

type PlanInput = Parameters<typeof planTransfer>[0]

async function runPreview(planInput: PlanInput, output: Output) {
  const plan = planTransfer({ ...planInput, options: { ...planInput.options, dryRun: true } })
  output.line('Scanning...')
  const result = await summarizeChangesFrom(plan)
  return result
}

function renderPreview(changes: readonly Change[], output: Output, destructive: boolean): void {
  const summary = summarizeChanges(changes)
  output.line('')
  output.line(
    table(
      [
        ['Add', String(summary.add)],
        ['Update', String(summary.update)],
        ['Metadata', String(summary.metadata)],
        ['Unchanged', String(summary.unchanged)],
        ...(destructive ? [['Delete', String(summary.delete)]] : []),
      ],
      ['Action', 'Files'],
    ),
  )
  output.line('')

  if (destructive && summary.delete > 0) {
    output.line('These destination files would be deleted:')
    for (const change of changes.filter((c) => c.action === 'delete').slice(0, 50)) {
      output.line(`  ${change.path}`)
    }
    if (summary.delete > 50) output.line(`  ... and ${summary.delete - 50} more`)
    output.line('')
  }
}

function transportFor(
  source: Awaited<ReturnType<typeof resolveEndpoint>>,
  destination: Awaited<ReturnType<typeof resolveEndpoint>>,
  topology: ReturnType<typeof topologyOf>,
) {
  if (topology === 'remote-to-remote') {
    return {
      sourceShell: shellOptionsFor(source),
      destinationShell: shellOptionsFor(destination),
      sourceRsyncPath: source.connection?.rsyncPath ?? null,
    }
  }
  const remote = source.endpoint.type === 'ssh' ? source : destination
  return { remoteShell: shellOptionsFor(remote) }
}

function shellOptionsFor(resolved: Awaited<ReturnType<typeof resolveEndpoint>>) {
  const connection = resolved.connection
  if (!connection) return {}
  return {
    keyPath: connection.authType === 'key' || connection.authType === 'key-passphrase' ? connection.keyPath : null,
    jumpHost: connection.jumpHost,
    forwardAgent: connection.forwardAgent,
    connectTimeoutSeconds: connection.connectTimeoutSeconds,
  }
}

async function effectiveCapabilities(
  store: DiskPushStore,
  source: Awaited<ReturnType<typeof resolveEndpoint>>,
  destination: Awaited<ReturnType<typeof resolveEndpoint>>,
): Promise<RsyncCapabilities> {
  let capabilities = detectLocalCapabilities()
  // Remote capabilities are only known if `diskpush connections test` has run.
  // Without them we keep the local view, which errs towards adding the safety
  // flags rather than omitting them.
  for (const resolved of [source, destination]) {
    if (!resolved.connection) continue
    const cached = await store.getSetting<RsyncCapabilities | null>(capabilityCacheKey(resolved.connection.id), null)
    if (cached) capabilities = intersectCapabilities(capabilities, cached)
  }
  return capabilities
}

function renderStored(endpoint: import('@diskpush/schemas').Endpoint): string {
  if (endpoint.type === 'local') return endpoint.path
  const prefix = endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host
  return `${prefix}:${endpoint.path}`
}

function describe(input: string): string {
  const colon = input.indexOf(':')
  return colon > 0 ? input.slice(0, colon) : 'local'
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

function reportPlanError(error: unknown, output: Output): number {
  if (error instanceof RsyncArgError) return failure(output, error.message, EXIT.refused)
  return failure(output, error instanceof Error ? error.message : String(error), EXIT.internal)
}

function finish(output: Output, code: number, message: string, extra: Record<string, unknown>): number {
  if (output.isJson) output.json({ status: code === 0 ? 'ok' : 'failed', message, ...extra })
  else output.line(message)
  return code
}
