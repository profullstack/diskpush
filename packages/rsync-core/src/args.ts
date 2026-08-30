import { topologyOf, type Endpoint, type RsyncOptions, type TransferTopology } from '@diskpush/schemas'
import { renderEndpoint } from './endpoint.js'
import { renderRemoteShell } from './remote-shell.js'
import { analyzeRawArgs, type RawArgIssue } from './raw-args.js'
import { unknownCapabilities, type RsyncCapabilities } from './version.js'

export class RsyncArgError extends Error {
  constructor(message: string, readonly issues: RawArgIssue[] = []) {
    super(message)
    this.name = 'RsyncArgError'
  }
}

export type BuildArgsInput = {
  source: Endpoint
  destination: Endpoint
  options: RsyncOptions
  /** SSH transport tokens, required whenever an endpoint is remote. */
  remoteShell?: readonly string[]
  /** Effective (intersected) capabilities of both ends. */
  capabilities?: RsyncCapabilities
  /**
   * Set only after the user has seen and confirmed the delete preview, or when
   * a profile has explicitly opted into unattended mirroring.
   */
  deletesConfirmed?: boolean
}

export type BuildArgsResult = {
  args: string[]
  /** Advisory notes: options dropped because one end is too old, etc. */
  warnings: string[]
  topology: TransferTopology
}

const COMPRESSION_FLAGS: Record<string, string[]> = {
  off: [],
  auto: [],
  zlib: ['--compress'],
  zstd: ['--compress', '--compress-choice=zstd'],
}

const DELETE_FLAGS: Record<string, string[]> = {
  off: [],
  delay: ['--delete-delay'],
  during: ['--delete-during'],
  after: ['--delete-after'],
}

/**
 * Builds the rsync argv.
 *
 * Every token here originates from a typed option, a validated endpoint, or
 * the caller's explicit pass-through list. Nothing is interpolated into a
 * string that a shell will later re-read.
 */
export function buildRsyncArgs(input: BuildArgsInput): BuildArgsResult {
  const { source, destination, options } = input
  const capabilities = input.capabilities ?? unknownCapabilities()
  const topology = topologyOf(source, destination)
  const warnings: string[] = []
  const args: string[] = []

  if (topology === 'remote-to-remote') {
    throw new RsyncArgError(
      'A single rsync invocation cannot have two remote endpoints. Build a server-to-server job instead (see buildServerToServerCommand).',
    )
  }

  const raw = analyzeRawArgs(options.rawArgs)

  // A confirmed mirror waives the destination-delete flags, because the user
  // has just been shown exactly what they would delete. It waives nothing
  // else: in particular `--remove-source-files` stays blocked, since no
  // amount of confirming a *destination* delete list says anything about
  // deleting the source.
  const mirrorConfirmed = options.deleteMode !== 'off' && input.deletesConfirmed === true
  const blocked = raw.issues.filter(
    (issue) => issue.severity === 'blocked' && !(mirrorConfirmed && issue.kind === 'destination-delete'),
  )
  if (blocked.length > 0) {
    throw new RsyncArgError(
      `These pass-through arguments were rejected:\n${blocked.map((i) => `  ${i.arg}: ${i.reason}`).join('\n')}`,
      blocked,
    )
  }
  for (const issue of raw.issues.filter((i) => i.severity === 'conflict')) {
    warnings.push(`${issue.arg}: ${issue.reason}`)
  }

  if (options.deleteMode !== 'off' && !options.dryRun && !input.deletesConfirmed) {
    throw new RsyncArgError(
      'Mirror mode deletes destination files. Run the dry-run preview and confirm the delete list before building a live mirror job.',
    )
  }

  // --- traversal + metadata -------------------------------------------------
  if (options.archive) args.push('--archive')
  else args.push('--recursive')

  if (options.hardLinks) args.push('--hard-links')
  if (options.acls) {
    if (capabilities.acls || !capabilities.version) args.push('--acls')
    else warnings.push('ACL preservation was dropped: at least one end of this transfer was not built with ACL support.')
  }
  if (options.xattrs) {
    if (capabilities.xattrs || !capabilities.version) args.push('--xattrs')
    else warnings.push('Extended attribute preservation was dropped: at least one end was not built with xattr support.')
  }
  if (options.numericIds) args.push('--numeric-ids')
  if (options.sparse) args.push('--sparse')

  // --- resume ---------------------------------------------------------------
  if (options.partial) {
    if (options.partialDir) args.push(`--partial-dir=${options.partialDir}`)
    else args.push('--partial')
  }

  // --- output ---------------------------------------------------------------
  if (options.humanReadable) args.push('--human-readable')
  if (options.itemizeAll) args.push('--itemize-changes', '--itemize-changes')
  else if (options.itemizeChanges) args.push('--itemize-changes')
  // --progress and --info=progress2 both set rsync's info flags, and the last
  // one wins, so only one of them is ever passed.
  if (options.perFileProgress) args.push('--progress')
  else if (options.progress) args.push('--info=progress2')
  if (options.stats) args.push('--stats')

  // --- synchronisation semantics -------------------------------------------
  args.push(...(DELETE_FLAGS[options.deleteMode] ?? []))
  if (options.checksum) args.push('--checksum')
  if (options.update) args.push('--update')
  if (options.ignoreExisting) args.push('--ignore-existing')
  if (options.existingOnly) args.push('--existing')

  // --- filters --------------------------------------------------------------
  // Includes precede excludes: rsync takes the first matching rule, so an
  // include listed after a broad exclude would never be reached.
  for (const include of options.includes) args.push(`--include=${include}`)
  if (options.includeFrom) args.push(`--include-from=${options.includeFrom}`)
  for (const exclude of options.excludes) args.push(`--exclude=${exclude}`)
  if (options.excludeFrom) args.push(`--exclude-from=${options.excludeFrom}`)
  if (options.filesFrom) args.push(`--files-from=${options.filesFrom}`)
  if (options.pruneEmptyDirs) args.push('--prune-empty-dirs')
  if (options.relative) args.push('--relative')
  if (options.maxSize) args.push(`--max-size=${options.maxSize}`)
  if (options.minSize) args.push(`--min-size=${options.minSize}`)

  // --- performance ----------------------------------------------------------
  const compression = resolveCompression(options.compression, capabilities, warnings)
  args.push(...compression)
  if (options.bwlimit) args.push(`--bwlimit=${options.bwlimit}`)
  if (options.wholeFile === 'on') args.push('--whole-file')
  else if (options.wholeFile === 'off') args.push('--no-whole-file')
  if (options.timeoutSeconds != null) args.push(`--timeout=${options.timeoutSeconds}`)
  if (options.mkpath) {
    if (capabilities.mkpath || !capabilities.version) args.push('--mkpath')
    else warnings.push('--mkpath was dropped: it needs rsync 3.2.3 or newer on both ends. Create the destination directory first.')
  }

  // --- advanced -------------------------------------------------------------
  if (options.inplace) args.push('--inplace')
  if (options.appendVerify) args.push('--append-verify')
  if (options.dryRun) args.push('--dry-run')

  // --- transport ------------------------------------------------------------
  const isRemote = topology === 'local-to-remote' || topology === 'remote-to-local'
  if (isRemote) {
    if (!input.remoteShell || input.remoteShell.length === 0) {
      throw new RsyncArgError('A remote endpoint was given but no SSH transport was configured for it.')
    }
    args.push('--rsh', renderRemoteShell(input.remoteShell))
    if (options.rsyncPath) args.push(`--rsync-path=${options.rsyncPath}`)

    // Without this, the remote login shell expands the remote path, and a path
    // containing `$(...)` or a backtick becomes remote code execution.
    // rsync 3.2.4 made it the default; older versions need it spelled out.
    if (!capabilities.secludedArgsByDefault) {
      if (capabilities.secludedArgsAvailable) {
        args.push('--protect-args')
      } else if (capabilities.version) {
        warnings.push(
          `rsync ${capabilities.version.raw} cannot shield remote paths from the remote shell (--protect-args needs 3.0.0+). ` +
            'Paths containing shell metacharacters are unsafe against this host.',
        )
      } else {
        // Version unknown: ask for protection anyway and let rsync complain
        // loudly rather than silently handing the path to a remote shell.
        args.push('--protect-args')
      }
    }
  } else if (options.rsyncPath) {
    warnings.push('A remote rsync path was set but this transfer has no remote endpoint; it was ignored.')
  }

  // --- pass-through ---------------------------------------------------------
  // Last, so that for options rsync resolves last-wins, the user's own tokens win.
  args.push(...options.rawArgs)

  args.push(renderEndpoint(source), renderEndpoint(destination))
  return { args, warnings, topology }
}

function resolveCompression(
  compression: RsyncOptions['compression'],
  capabilities: RsyncCapabilities,
  warnings: string[],
): string[] {
  if (compression === 'zstd' && capabilities.version && !capabilities.zstd) {
    warnings.push('zstd compression was downgraded to zlib: at least one end of this transfer was not built with zstd.')
    return ['--compress']
  }
  return COMPRESSION_FLAGS[compression] ?? []
}

/**
 * The command as a person would type it. For display and for the log only -
 * it is never handed to a shell.
 */
export function renderCommand(args: readonly string[], binary = 'rsync'): string {
  const quoted = args.map((arg) => (/[\s"'$`\\]/.test(arg) ? `'${arg.replaceAll("'", `'\\''`)}'` : arg))
  return [binary, ...quoted].join(' ')
}
