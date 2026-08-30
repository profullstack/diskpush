import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { knownHostsPath, type DiskPushStore } from '@diskpush/database'
import {
  BUILTIN_RECIPES,
  buildUpgradeScript,
  checkFleet,
  copyRecipe,
  describeHazards,
  inspectScript,
  needsAttention,
  parseSelector,
  runFleet,
  selectConnections,
  SelectionError,
  type SudoMode,
} from '@diskpush/fleet-core'
import {
  isListTerm,
  listTermName,
  FLEET_DEFAULT_CONCURRENCY,
  FLEET_DEFAULT_TIMEOUT_SECONDS,
  FleetInterpreterSchema,
  type Connection,
  type FleetHostResult,
  type FleetInterpreter,
  type HostUpdateReport,
} from '@diskpush/schemas'
import { SshSession } from '@diskpush/ssh-core'
import { EXIT } from '../exit-codes.js'
import { formatDuration, table } from '../format.js'
import { failure, type Output } from '../output.js'
import { ArgvError, flagValue, flagValues, hasFlag, numberFlag, type ParsedArgv } from '../parse-argv.js'
import { sshConfigHosts } from '../resolve.js'

/**
 * `diskpush fleet` — one command, many servers.
 *
 * The transfer side of DiskPush moves bytes to a server. This moves work to a
 * set of them, and it holds itself to the same bargain the transfer side
 * does: show exactly what will run, on exactly which hosts, before running
 * it, and never report success on behalf of a host that did not report it.
 */

export async function runFleetCommand(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  try {
    return await dispatch(parsed, store, output)
  } catch (error) {
    // A bad selector is a configuration mistake, not a crash, and under
    // --json it has to come back as JSON like every other failure rather than
    // as a bare line on stderr from the top-level handler.
    if (error instanceof SelectionError) return failure(output, error.message, EXIT.configuration)
    if (error instanceof ArgvError) return failure(output, error.message, EXIT.usage)
    throw error
  }
}

async function dispatch(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const subcommand = parsed.positionals[0] ?? 'help'

  switch (subcommand) {
    case 'run':
    case 'exec':
      return fleetRun(parsed, store, output)
    case 'script':
      return fleetScript(parsed, store, output)
    case 'upgrade':
      return fleetUpgrade(parsed, store, output)
    case 'check':
    case 'status':
      return fleetCheck(parsed, store, output)
    case 'servers':
    case 'targets':
      return fleetServers(parsed, store, output)
    case 'commands':
      return fleetCommands(parsed, store, output)
    case 'lists':
    case 'list':
      return fleetLists(parsed, store, output)
    case 'runs':
      return fleetRuns(parsed, store, output)
    case 'show':
      return fleetShow(parsed, store, output)
    default:
      return failure(
        output,
        `Unknown subcommand ${JSON.stringify(subcommand)}. ` +
          'Try: run, script, upgrade, check, servers, lists, commands, runs, show.',
        EXIT.usage,
      )
  }
}

// --- selecting the fleet ---------------------------------------------------

/**
 * Everything a fleet command may run on.
 *
 * Saved connections and `~/.ssh/config` hosts, with saved winning on a name
 * clash. Including ssh_config matters: most people already have their servers
 * in that file, and making them re-enter twenty hosts before the first fleet
 * command is how a feature goes unused.
 */
async function availableConnections(store: DiskPushStore): Promise<Connection[]> {
  const saved = await store.listConnections()
  const savedNames = new Set(saved.map((connection) => connection.name))
  return [...saved, ...sshConfigHosts().filter((host) => !savedNames.has(host.name))]
}

type Targets = { connections: Connection[]; selector: string[] }

async function resolveTargets(parsed: ParsedArgv, store: DiskPushStore, fallback: readonly string[] = []): Promise<Targets> {
  const selector = flagValues(parsed, '--on')
  const terms = selector.length > 0 ? selector : [...fallback]

  if (terms.length === 0) {
    throw new ArgvError(
      'No servers selected. Add --on with a name, a glob, tag:NAME, or all.\n' +
        'Run `diskpush fleet servers` to see what is available.',
    )
  }

  const available = await availableConnections(store)
  const selection = await resolveSelector(terms, store, available)

  if (selection.unmatched.length > 0) {
    // A typo'd host is not a smaller fleet. Refusing here is the difference
    // between "upgraded 11 of 12" and "upgraded 11, silently skipped one".
    throw new SelectionError(
      `No server matches ${selection.unmatched.map((term) => JSON.stringify(term)).join(', ')}. ` +
        'Run `diskpush fleet servers` to see the names and tags DiskPush knows about.',
    )
  }
  if (selection.matched.length === 0) {
    throw new SelectionError('That selector matched no servers after exclusions.')
  }

  return { connections: selection.matched, selector: terms }
}

/**
 * Parse, expand any `list:` terms, then select.
 *
 * The order matters and got it wrong once: `parseSelector` is what splits
 * `--on 'all,!list:web'` into terms, so expanding before that leaves
 * `all,!list:web` as one unrecognised string and the exclusion silently does
 * nothing. Everything that resolves a selector goes through here so there is
 * one order rather than one per caller.
 */
async function resolveSelector(
  terms: readonly string[],
  store: DiskPushStore,
  available: readonly Connection[],
): Promise<ReturnType<typeof selectConnections>> {
  return selectConnections(available, await expandLists(parseSelector(terms), store, available))
}

/**
 * Turns `list:production` into the servers that list holds.
 *
 * Expanded here rather than inside `selectConnections`, which is a pure
 * function over connections and has no business reaching for a database.
 *
 * A member whose connection has since been deleted is named and refused
 * rather than skipped: a list that quietly shrinks is how a command misses
 * the one server it most needed to reach.
 */
async function expandLists(
  terms: readonly string[],
  store: DiskPushStore,
  available: readonly Connection[],
): Promise<string[]> {
  const byId = new Map(available.map((connection) => [connection.id, connection]))
  const expandedTerms: string[] = []

  for (const term of terms) {
    const negated = term.startsWith('!')
    const bare = negated ? term.slice(1) : term
    if (!isListTerm(bare)) {
      expandedTerms.push(term)
      continue
    }

    const name = listTermName(bare)
    const list = await store.findFleetList(name)
    if (!list) throw new SelectionError(`No saved list named ${JSON.stringify(name)}. Run \`diskpush fleet lists\`.`)
    if (list.members.length === 0) throw new SelectionError(`The list ${JSON.stringify(name)} has no servers in it.`)

    const missing = list.members.filter((member) => !byId.has(member.connectionId))
    if (missing.length > 0) {
      throw new SelectionError(
        `The list ${JSON.stringify(name)} names ${missing.length} server(s) that no longer exist: ` +
          `${missing.map((member) => member.connectionName).join(', ')}. ` +
          'Save the list again to drop them.',
      )
    }
    // Ids, not names: a list resolves to exactly the servers it was saved with,
    // even if one has been renamed since.
    for (const member of list.members) expandedTerms.push(`${negated ? '!' : ''}${member.connectionId}`)
  }

  return expandedTerms
}

// --- prompts ---------------------------------------------------------------

/**
 * Reads a line without echoing it. Used for a sudo password and nothing else.
 *
 * Raw mode and a manual read, rather than readline with its `_writeToOutput`
 * overridden. That override is the widely-copied recipe for this and it does
 * not work on current Node — the interface writes the refreshed line straight
 * to the output, so the password appears on screen and stays in the
 * terminal's scrollback. Verified by driving this under a pty; the recipe
 * echoed `hunter2` in full.
 *
 * In raw mode the tty does no echoing of its own, so nothing can leak by
 * default rather than by our getting the interception right.
 */
async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) throw new ArgvError('A sudo password can only be asked for on a terminal.')

  process.stderr.write(promptText)
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  return new Promise<string>((resolve, reject) => {
    let value = ''

    /** `leftover` is anything after the newline: it belongs to whoever reads next. */
    const restore = (leftover: string) => {
      stdin.removeListener('data', onData)
      if (!wasRaw) stdin.setRawMode(false)
      stdin.pause()
      if (leftover) stdin.unshift(leftover)
    }

    const onData = (chunk: string) => {
      for (let index = 0; index < chunk.length; index += 1) {
        const character = chunk[index]!
        switch (character) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl-D
            restore(chunk.slice(index + 1))
            process.stderr.write('\n')
            resolve(value)
            return
          case '\u0003': // Ctrl-C. Raw mode swallows the signal, so honour it here.
            restore('')
            process.stderr.write('\n')
            reject(new ArgvError('Cancelled.'))
            return
          case '\u007f': // Backspace
          case '\b':
            value = value.slice(0, -1)
            break
          default:
            // Control characters are not part of a password; dropping them
            // keeps an arrow key from ending up in what is sent to sudo.
            if (character >= ' ') value += character
        }
      }
    }

    stdin.on('data', onData)
  })
}

async function confirm(output: Output, question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    output.error('Refusing to continue without confirmation, and there is no terminal to ask on. Re-run with --yes.')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

// --- the shared run path ---------------------------------------------------

type FleetInvocation = {
  label: string
  script: string
  interpreter: FleetInterpreter
  sudo: boolean
  workingDirectory: string | null
  timeoutSeconds: number
  commandId: string | null
  targetFallback: readonly string[]
  /** From a saved command when it came from one; a flag always wins. */
  concurrency?: number
  onFailure?: 'continue' | 'stop'
  /**
   * The caller already asked about this script's hazards in terms specific to
   * what it does. `fleet upgrade --reboot` names the servers it will restart,
   * which is a better question than "this contains `shutdown`, continue?" —
   * and asking both makes the second one furniture.
   */
  hazardsAcknowledged?: boolean
}

function invocationFromFlags(parsed: ParsedArgv): Pick<FleetInvocation, 'interpreter' | 'workingDirectory' | 'timeoutSeconds'> {
  const interpreter = flagValue(parsed, '--interpreter')
  return {
    interpreter: interpreter ? FleetInterpreterSchema.parse(interpreter) : 'sh',
    workingDirectory: flagValue(parsed, '--cwd') ?? null,
    timeoutSeconds: numberFlag(parsed, '--timeout') ?? FLEET_DEFAULT_TIMEOUT_SECONDS,
  }
}

/** `--env KEY=VALUE`, repeatable. */
function envFromFlags(parsed: ParsedArgv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of flagValues(parsed, '--env')) {
    const equals = entry.indexOf('=')
    if (equals <= 0) throw new ArgvError(`--env takes KEY=VALUE, got ${JSON.stringify(entry)}.`)
    env[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  return env
}

/**
 * The one place a fleet command actually runs.
 *
 * Shared by `run`, `script` and `upgrade` so that the confirmation, the
 * hazard check, the live output, the summary and the recorded history are
 * identical whichever door you came in through.
 */
async function execute(
  invocation: FleetInvocation,
  parsed: ParsedArgv,
  store: DiskPushStore,
  output: Output,
): Promise<number> {
  const targets = await resolveTargets(parsed, store, invocation.targetFallback)
  const concurrency = numberFlag(parsed, '--concurrency') ?? invocation.concurrency ?? FLEET_DEFAULT_CONCURRENCY
  const onFailure = hasFlag(parsed, '--stop-on-error') ? 'stop' : (invocation.onFailure ?? 'continue')
  const env = envFromFlags(parsed)
  const assumeYes = hasFlag(parsed, '--yes')

  const sudo: SudoMode = !invocation.sudo ? 'off' : hasFlag(parsed, '--sudo-password') ? 'password' : 'non-interactive'

  // `--print-command` is a pipeline: `diskpush fleet upgrade --print-command
  // > upgrade.sh` has to produce a script and nothing else, so it returns
  // before any of the framing below.
  if (hasFlag(parsed, '--print-command')) {
    process.stdout.write(`${invocation.script}\n`)
    return EXIT.ok
  }

  // --- what is about to happen, before anything happens --------------------
  //
  // On stderr, not stdout: the command's own output is the result of this
  // command, and `diskpush fleet run "cat /etc/hostname" --on all | sort`
  // must not have a three-line preamble in the middle of it.
  output.warn(`Command: ${invocation.label}`)
  output.warn(
    `Servers: ${targets.connections.length} (${targets.connections.map((connection) => connection.name).join(', ')})`,
  )
  output.warn(
    `Running: ${concurrency} at a time, ${invocation.timeoutSeconds}s timeout each${sudo === 'off' ? '' : ', via sudo'}\n`,
  )

  if (hasFlag(parsed, '--dry-run')) {
    if (output.isJson) {
      output.json({
        status: 'ok',
        dryRun: true,
        script: invocation.script,
        servers: targets.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          host: connection.host,
        })),
      })
    } else {
      output.line('--dry-run: nothing was run. The script above would go to each of those servers.')
    }
    return EXIT.ok
  }

  // A script that matches a known way to lose a machine does not fan out
  // until someone says so out loud.
  const hazards = invocation.hazardsAcknowledged ? [] : inspectScript(invocation.script)
  if (hazards.length > 0) {
    output.warn(`This command matches ${hazards.length === 1 ? 'a pattern' : 'patterns'} that can destroy a server:\n`)
    for (const line of describeHazards(hazards)) output.warn(`  ${line}\n`)
    output.warn(`It would run on ${targets.connections.length} server(s).\n`)
    if (!assumeYes && !(await confirm(output, 'Run it anyway?'))) {
      return failure(output, 'Cancelled.', EXIT.refused)
    }
  }

  const sudoPassword = sudo === 'password' ? await readSecret('sudo password: ') : undefined

  // --- record the run before it starts -------------------------------------

  const runId = randomUUID()
  await store.createFleetRun({
    id: runId,
    commandId: invocation.commandId,
    label: invocation.label,
    script: invocation.script,
    interpreter: invocation.interpreter,
    sudo: invocation.sudo,
    workingDirectory: invocation.workingDirectory,
    timeoutSeconds: invocation.timeoutSeconds,
    concurrency,
    onFailure,
    targetSelector: targets.selector,
    state: 'running',
    hostsTotal: targets.connections.length,
    hostsSucceeded: 0,
    hostsFailed: 0,
    completedAt: null,
  })

  // Ctrl-C stops the run rather than killing the process mid-write, so the
  // per-host results already collected are still recorded.
  const controller = new AbortController()
  const onInterrupt = () => {
    output.warn('\nStopping. Servers already running are being signalled; the rest are cancelled.')
    controller.abort()
  }
  process.once('SIGINT', onInterrupt)

  const width = Math.max(...targets.connections.map((connection) => connection.name.length))
  const live = !output.isJson && !hasFlag(parsed, '--quiet')

  try {
    const run = await runFleet({
      connections: targets.connections,
      script: invocation.script,
      interpreter: invocation.interpreter,
      sudo,
      sudoPassword,
      workingDirectory: invocation.workingDirectory,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      timeoutSeconds: invocation.timeoutSeconds,
      concurrency,
      onFailure,
      // `sh -e` is the default. `--no-fail-fast` is for a probe script whose
      // commands are expected to fail as part of doing their job.
      failFast: !hasFlag(parsed, '--no-fail-fast'),
      runId,
      signal: controller.signal,
      connect: (connection) => SshSession.connect(connection, sessionOptions(parsed)),
      // The CLI opens one connection per host and owns it. The desktop pools
      // sessions and deliberately does not.
      release: (session) => session.close(),
      onEvent: (event) => {
        if (!live) return
        const name = (id: string) =>
          targets.connections.find((connection) => connection.id === id)?.name ?? id
        if (event.type === 'host-stdout') output.line(`${name(event.connectionId).padEnd(width)} | ${event.line}`)
        if (event.type === 'host-stderr') output.line(`${name(event.connectionId).padEnd(width)} ! ${event.line}`)
      },
    })

    for (const result of run.results) await store.saveFleetHostResult(result)
    await store.completeFleetRun(runId, {
      state: run.state,
      hostsSucceeded: run.succeeded,
      hostsFailed: run.failed,
    })

    if (output.isJson) {
      output.json({
        status: run.state === 'completed' ? 'ok' : 'failed',
        runId,
        state: run.state,
        succeeded: run.succeeded,
        failed: run.failed,
        skipped: run.skipped,
        hosts: run.results,
      })
    } else {
      output.line()
      output.line(resultTable(run.results))
      output.line()
      output.line(
        `${run.succeeded} succeeded, ${run.failed} failed` +
          `${run.skipped > 0 ? `, ${run.skipped} not run` : ''}. Run ${runId.slice(0, 8)}.`,
      )
      if (run.failed > 0) output.line(`Full output: diskpush fleet show ${runId.slice(0, 8)}`)
    }

    return run.failed > 0 || run.skipped > 0 ? EXIT.fleetIncomplete : EXIT.ok
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

function sessionOptions(parsed: ParsedArgv) {
  return {
    knownHostsPath: knownHostsPath(),
    onUnknownHostKey: async (details: { host: string; keyType: string; fingerprint: string }) => {
      // A fan-out is exactly the wrong moment to be answering host key
      // prompts one at a time, so an unknown host fails unless --accept-new
      // was passed deliberately for this run.
      if (hasFlag(parsed, '--accept-new')) return true
      throw new Error(
        `${details.host} is not in known_hosts (${details.keyType} ${details.fingerprint}). ` +
          'Run `diskpush connections test NAME` to check it once, or pass --accept-new.',
      )
    },
  }
}

function resultTable(results: readonly FleetHostResult[]): string {
  return table(
    results.map((result) => [
      result.connectionName,
      result.host,
      result.state,
      result.exitCode === null ? '-' : String(result.exitCode),
      result.durationMs === null ? '-' : formatDuration(result.durationMs / 1000),
      (result.errorSummary ?? '').slice(0, 60),
    ]),
    ['SERVER', 'HOST', 'STATE', 'EXIT', 'TIME', 'NOTE'],
  )
}

// --- subcommands -----------------------------------------------------------

async function fleetRun(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const savedName = flagValue(parsed, '--command')
  const inline = parsed.positionals.slice(1).join(' ')

  if (savedName) {
    const command = await store.findFleetCommand(savedName, BUILTIN_RECIPES)
    if (!command) {
      return failure(
        output,
        `No saved command or recipe named ${JSON.stringify(savedName)}. Run \`diskpush fleet commands\`.`,
        EXIT.configuration,
      )
    }
    return execute(
      {
        label: command.name,
        script: command.script,
        interpreter: command.interpreter,
        sudo: command.sudo || hasFlag(parsed, '--sudo'),
        workingDirectory: flagValue(parsed, '--cwd') ?? command.workingDirectory,
        timeoutSeconds: numberFlag(parsed, '--timeout') ?? command.timeoutSeconds,
        concurrency: numberFlag(parsed, '--concurrency') ?? command.concurrency,
        onFailure: hasFlag(parsed, '--stop-on-error') ? 'stop' : command.onFailure,
        commandId: command.builtin ? null : command.id,
        targetFallback: command.targets,
      },
      parsed,
      store,
      output,
    )
  }

  if (!inline) {
    return failure(
      output,
      'Usage: diskpush fleet run "COMMAND" --on SELECTOR\n' +
        '   or: diskpush fleet run --command NAME --on SELECTOR\n' +
        '   or: diskpush fleet script FILE --on SELECTOR',
      EXIT.usage,
    )
  }

  const flags = invocationFromFlags(parsed)
  return execute(
    {
      label: inline.length > 60 ? `${inline.slice(0, 57)}...` : inline,
      script: inline,
      // A one-liner typed at a shell prompt should behave like one; `sh -es`
      // around `uptime` buys nothing and surprises anyone who pipes.
      interpreter: flagValue(parsed, '--interpreter') ? flags.interpreter : 'raw',
      sudo: hasFlag(parsed, '--sudo') || hasFlag(parsed, '--sudo-password'),
      workingDirectory: flags.workingDirectory,
      timeoutSeconds: flags.timeoutSeconds,
      commandId: null,
      targetFallback: [],
    },
    parsed,
    store,
    output,
  )
}

async function fleetScript(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const path = parsed.positionals[1] ?? flagValue(parsed, '--script')
  if (!path) return failure(output, 'Usage: diskpush fleet script FILE --on SELECTOR', EXIT.usage)

  let script: string
  try {
    script = readFileSync(path, 'utf8')
  } catch (error) {
    return failure(output, `Could not read ${path}: ${(error as Error).message}`, EXIT.configuration)
  }
  if (script.trim().length === 0) return failure(output, `${path} is empty.`, EXIT.usage)

  const flags = invocationFromFlags(parsed)
  return execute(
    {
      label: path,
      script,
      // A `#!/bin/bash` line means the author has already said which shell
      // this needs, and honouring it is cheaper than making them repeat it.
      interpreter: flagValue(parsed, '--interpreter')
        ? flags.interpreter
        : /^#!.*\bbash\b/.test(script)
          ? 'bash'
          : 'sh',
      sudo: hasFlag(parsed, '--sudo') || hasFlag(parsed, '--sudo-password'),
      workingDirectory: flags.workingDirectory,
      timeoutSeconds: flags.timeoutSeconds,
      commandId: null,
      targetFallback: [],
    },
    parsed,
    store,
    output,
  )
}

async function fleetUpgrade(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const rebootFlag = flagValue(parsed, '--reboot')
  const reboot =
    rebootFlag === 'always'
      ? 'always'
      : hasFlag(parsed, '--reboot')
        ? 'if-needed'
        : 'never'

  // Neither of those inspects anything, so neither may prompt: `--print-command`
  // piped into a file must not stop on a question nobody is there to answer.
  const inspecting = hasFlag(parsed, '--print-command') || hasFlag(parsed, '--dry-run')

  if (reboot !== 'never' && !inspecting && !hasFlag(parsed, '--yes')) {
    const targets = await resolveTargets(parsed, store)
    output.warn(
      `--reboot will restart ${targets.connections.length} server(s) ` +
        `${reboot === 'always' ? 'whether or not they need it' : 'that report needing one'}.`,
    )
    if (!(await confirm(output, 'Continue?'))) return failure(output, 'Cancelled.', EXIT.refused)
  }

  return execute(
    {
      label: `upgrade packages${reboot === 'never' ? '' : ` (reboot: ${reboot})`}`,
      script: buildUpgradeScript({ reboot }),
      interpreter: 'sh',
      // Installing packages needs root everywhere. --no-sudo is there for the
      // fleet that already connects as root.
      sudo: !hasFlag(parsed, '--no-sudo'),
      workingDirectory: null,
      timeoutSeconds: numberFlag(parsed, '--timeout') ?? 3600,
      commandId: null,
      targetFallback: [],
      // Reaching here with a reboot policy means the question above was
      // already answered, by name, for these servers.
      hazardsAcknowledged: reboot !== 'never',
    },
    parsed,
    store,
    output,
  )
}

async function fleetCheck(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const targets = await resolveTargets(parsed, store)
  const concurrency = numberFlag(parsed, '--concurrency') ?? FLEET_DEFAULT_CONCURRENCY

  if (!output.isJson) output.line(`Checking ${targets.connections.length} server(s)...\n`)

  const { reports, unreachable } = await checkFleet({
    connections: targets.connections,
    concurrency,
    ...(numberFlag(parsed, '--timeout') !== undefined ? { timeoutSeconds: numberFlag(parsed, '--timeout')! } : {}),
    connect: (connection) => SshSession.connect(connection, sessionOptions(parsed)),
    release: (session) => session.close(),
  })

  const shown = hasFlag(parsed, '--pending') ? needsAttention(reports) : reports

  if (output.isJson) {
    output.json({ status: unreachable > 0 ? 'partial' : 'ok', reports: shown })
    return unreachable > 0 ? EXIT.fleetIncomplete : EXIT.ok
  }

  if (shown.length === 0) {
    output.line('Every server is up to date and none is waiting on a reboot.')
    return EXIT.ok
  }

  output.line(checkTable(shown))

  // Why a host could not be reached goes below the table, not in a column:
  // "Timed out while waiting for handshake" does not fit next to an uptime,
  // and squeezing it in there is how it ends up looking like one.
  const unreachableReports = shown.filter((report) => !report.reachable)
  if (unreachableReports.length > 0) {
    output.line()
    for (const report of unreachableReports) {
      output.line(`${report.connectionName}: ${report.error ?? 'did not answer'}`)
    }
  }

  const pending = reports.filter((report) => (report.updates ?? 0) > 0).length
  const rebooting = reports.filter((report) => report.rebootRequired === true).length
  output.line()
  output.line(
    [
      `${pending} server(s) with updates`,
      `${rebooting} waiting on a reboot`,
      unreachable > 0 ? `${unreachable} unreachable` : null,
    ]
      .filter(Boolean)
      .join(', ') + '.',
  )
  if (pending > 0) output.line('Install them with: diskpush fleet upgrade --on ' + (flagValues(parsed, '--on')[0] ?? 'all'))

  return unreachable > 0 ? EXIT.fleetIncomplete : EXIT.ok
}

function checkTable(reports: readonly HostUpdateReport[]): string {
  return table(
    reports.map((report) => [
      report.connectionName,
      report.reachable ? (report.os ?? 'unknown') : 'unreachable',
      report.packageManager,
      report.updates === null ? '?' : String(report.updates),
      report.securityUpdates === null ? '-' : String(report.securityUpdates),
      report.rebootRequired === null ? '?' : report.rebootRequired ? 'YES' : 'no',
      report.diskUsedPercent === null ? '-' : `${report.diskUsedPercent}%`,
      report.uptimeSeconds === null ? '-' : formatUptime(report.uptimeSeconds),
    ]),
    ['SERVER', 'OS', 'PM', 'UPD', 'SEC', 'REBOOT', 'DISK', 'UPTIME'],
  )
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  if (days > 0) return `${days}d`
  return `${Math.floor(seconds / 3600)}h`
}

async function fleetServers(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const available = await availableConnections(store)
  const selector = flagValues(parsed, '--on')
  const shown = selector.length > 0 ? (await resolveSelector(selector, store, available)).matched : available

  if (output.isJson) {
    output.json({ status: 'ok', servers: shown })
    return EXIT.ok
  }
  if (shown.length === 0) {
    output.line('No servers. Add one with `diskpush connections add NAME user@host`, or import ~/.ssh/config.')
    return EXIT.ok
  }

  const savedIds = new Set((await store.listConnections()).map((connection) => connection.id))
  output.line(
    table(
      shown.map((connection) => [
        connection.name,
        `${connection.username}@${connection.host}:${connection.port}`,
        connection.tags.join(',') || '-',
        savedIds.has(connection.id) ? 'saved' : 'ssh_config',
      ]),
      ['SERVER', 'TARGET', 'TAGS', 'FROM'],
    ),
  )
  return EXIT.ok
}

async function fleetCommands(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const action = parsed.positionals[1] ?? 'list'

  if (action === 'list') {
    const commands = await store.listFleetCommands(BUILTIN_RECIPES)
    if (output.isJson) {
      output.json({ status: 'ok', commands })
      return EXIT.ok
    }
    output.line(
      table(
        commands.map((command) => [
          command.name,
          command.builtin ? 'built-in' : 'saved',
          command.sudo ? 'sudo' : '-',
          command.targets.join(',') || '-',
          command.description.slice(0, 56),
        ]),
        ['NAME', 'SOURCE', 'ROOT', 'DEFAULT TARGETS', 'DESCRIPTION'],
      ),
    )
    return EXIT.ok
  }

  if (action === 'show') {
    const name = parsed.positionals[2]
    if (!name) return failure(output, 'Usage: diskpush fleet commands show NAME', EXIT.usage)
    const command = await store.findFleetCommand(name, BUILTIN_RECIPES)
    if (!command) return failure(output, `No command named ${JSON.stringify(name)}.`, EXIT.configuration)
    if (output.isJson) output.json({ status: 'ok', command })
    else {
      output.line(`${command.name}${command.builtin ? '  (built-in)' : ''}`)
      if (command.description) output.line(command.description)
      output.line()
      output.line(command.script)
    }
    return EXIT.ok
  }

  if (action === 'save') {
    const name = parsed.positionals[2]
    const scriptPath = flagValue(parsed, '--script')
    const inline = parsed.positionals.slice(3).join(' ')
    if (!name || (!scriptPath && !inline)) {
      return failure(output, 'Usage: diskpush fleet commands save NAME --script FILE | "COMMAND"', EXIT.usage)
    }

    let script = inline
    if (scriptPath) {
      try {
        script = readFileSync(scriptPath, 'utf8')
      } catch (error) {
        return failure(output, `Could not read ${scriptPath}: ${(error as Error).message}`, EXIT.configuration)
      }
    }

    const flags = invocationFromFlags(parsed)
    const saved = await store.saveFleetCommand({
      name,
      description: flagValue(parsed, '--description') ?? '',
      script,
      interpreter: flags.interpreter,
      sudo: hasFlag(parsed, '--sudo'),
      workingDirectory: flags.workingDirectory,
      timeoutSeconds: flags.timeoutSeconds,
      // Pacing is part of the command, not of the invocation: a saved command
      // that forgets it was meant to run two at a time is a saved command that
      // still gets run wrong.
      concurrency: numberFlag(parsed, '--concurrency') ?? FLEET_DEFAULT_CONCURRENCY,
      onFailure: hasFlag(parsed, '--stop-on-error') ? 'stop' : 'continue',
      targets: flagValues(parsed, '--on'),
      tags: flagValues(parsed, '--tag'),
    })
    if (output.isJson) output.json({ status: 'ok', command: saved })
    else output.line(`Saved command ${saved.name}. Run it with: diskpush fleet run --command ${saved.name} --on SELECTOR`)
    return EXIT.ok
  }

  if (action === 'copy') {
    const source = parsed.positionals[2]
    const target = parsed.positionals[3] ?? flagValue(parsed, '--as')
    if (!source || !target) return failure(output, 'Usage: diskpush fleet commands copy NAME NEW-NAME', EXIT.usage)
    const command = await store.findFleetCommand(source, BUILTIN_RECIPES)
    if (!command) return failure(output, `No command named ${JSON.stringify(source)}.`, EXIT.configuration)

    const saved = await store.saveFleetCommand(copyRecipe(command, target))
    if (output.isJson) output.json({ status: 'ok', command: saved })
    else output.line(`Copied ${command.name} to ${saved.name}. It is yours to edit now.`)
    return EXIT.ok
  }

  if (action === 'remove' || action === 'rm') {
    const name = parsed.positionals[2]
    if (!name) return failure(output, 'Usage: diskpush fleet commands remove NAME', EXIT.usage)
    const removed = await store.deleteFleetCommand(name)
    if (!removed) {
      const builtin = BUILTIN_RECIPES.find((recipe) => recipe.name === name)
      return failure(
        output,
        builtin
          ? `${name} is a built-in recipe and cannot be removed. Copy it instead: diskpush fleet commands copy ${name} my-${name}`
          : `No saved command named ${JSON.stringify(name)}.`,
        EXIT.configuration,
      )
    }
    if (output.isJson) output.json({ status: 'ok', removed: name })
    else output.line(`Removed command ${name}.`)
    return EXIT.ok
  }

  return failure(output, `Unknown action ${JSON.stringify(action)}. Try: list, show, save, copy, remove.`, EXIT.usage)
}

/**
 * Saved sets of servers.
 *
 * Tags say what a server *is*; a list is a set someone assembled by hand and
 * wants back. Used as `--on list:NAME`, prefixed so a list and a server may
 * share a name without either shadowing the other.
 */
async function fleetLists(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const action = parsed.positionals[1] ?? 'list'

  if (action === 'list') {
    const lists = await store.listFleetLists()
    if (output.isJson) {
      output.json({ status: 'ok', lists })
      return EXIT.ok
    }
    if (lists.length === 0) {
      output.line('No saved lists. Make one with: diskpush fleet lists save NAME --on tag:production')
      return EXIT.ok
    }
    output.line(
      table(
        lists.map((list) => [
          list.name,
          String(list.members.length),
          list.members.slice(0, 4).map((member) => member.connectionName).join(', ') +
            (list.members.length > 4 ? ', ...' : ''),
          list.description.slice(0, 40),
        ]),
        ['LIST', 'SERVERS', 'MEMBERS', 'DESCRIPTION'],
      ),
    )
    return EXIT.ok
  }

  if (action === 'show') {
    const name = parsed.positionals[2]
    if (!name) return failure(output, 'Usage: diskpush fleet lists show NAME', EXIT.usage)
    const list = await store.findFleetList(name)
    if (!list) return failure(output, `No saved list named ${JSON.stringify(name)}.`, EXIT.configuration)

    if (output.isJson) {
      output.json({ status: 'ok', list })
      return EXIT.ok
    }

    // A member whose connection has gone is shown as missing rather than
    // dropped: that is the difference between a list you can trust and one
    // that quietly got smaller.
    const available = await availableConnections(store)
    const byId = new Map(available.map((connection) => [connection.id, connection]))
    output.line(`${list.name}${list.description ? `  ${list.description}` : ''}`)
    output.line()
    output.line(
      table(
        list.members.map((member) => {
          const live = byId.get(member.connectionId)
          return [
            member.connectionName,
            live ? `${live.username}@${live.host}:${live.port}` : '-',
            live ? 'ok' : 'MISSING',
          ]
        }),
        ['SERVER', 'TARGET', 'STATE'],
      ),
    )
    return EXIT.ok
  }

  if (action === 'save') {
    const name = parsed.positionals[2]
    if (!name) return failure(output, 'Usage: diskpush fleet lists save NAME --on SELECTOR', EXIT.usage)
    if (isListTerm(name)) {
      return failure(output, `A list is named without the ${JSON.stringify('list:')} prefix.`, EXIT.usage)
    }

    // Resolved now, and stored as members. A list is a set someone chose, not
    // a query that might mean something different next week.
    const targets = await resolveTargets(parsed, store)
    const saved = await store.saveFleetList({
      name,
      description: flagValue(parsed, '--description') ?? '',
      members: targets.connections.map((connection) => ({
        connectionId: connection.id,
        connectionName: connection.name,
      })),
    })

    if (output.isJson) output.json({ status: 'ok', list: saved })
    else {
      output.line(`Saved list ${saved.name} with ${saved.members.length} server(s).`)
      output.line(`Use it with: diskpush fleet run "uptime" --on list:${saved.name}`)
    }
    return EXIT.ok
  }

  if (action === 'rename') {
    const [, , from, to] = parsed.positionals
    if (!from || !to) return failure(output, 'Usage: diskpush fleet lists rename NAME NEW-NAME', EXIT.usage)
    const renamed = await store.renameFleetList(from, to)
    if (!renamed) return failure(output, `No saved list named ${JSON.stringify(from)}.`, EXIT.configuration)
    if (output.isJson) output.json({ status: 'ok', list: renamed })
    else output.line(`Renamed list ${from} to ${renamed.name}.`)
    return EXIT.ok
  }

  if (action === 'remove' || action === 'rm') {
    const name = parsed.positionals[2]
    if (!name) return failure(output, 'Usage: diskpush fleet lists remove NAME', EXIT.usage)
    const removed = await store.deleteFleetList(name)
    if (!removed) return failure(output, `No saved list named ${JSON.stringify(name)}.`, EXIT.configuration)
    if (output.isJson) output.json({ status: 'ok', removed: name })
    else output.line(`Removed list ${name}. The servers themselves are untouched.`)
    return EXIT.ok
  }

  return failure(output, `Unknown action ${JSON.stringify(action)}. Try: list, show, save, rename, remove.`, EXIT.usage)
}

async function fleetRuns(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const runs = await store.listFleetRuns(numberFlag(parsed, '--limit') ?? 25)
  if (output.isJson) {
    output.json({ status: 'ok', runs })
    return EXIT.ok
  }
  if (runs.length === 0) {
    output.line('No fleet runs yet.')
    return EXIT.ok
  }
  output.line(
    table(
      runs.map((run) => [
        run.id.slice(0, 8),
        run.createdAt.slice(0, 19).replace('T', ' '),
        run.state,
        `${run.hostsSucceeded}/${run.hostsTotal}`,
        run.label.slice(0, 52),
      ]),
      ['ID', 'WHEN', 'STATE', 'OK', 'COMMAND'],
    ),
  )
  return EXIT.ok
}

async function fleetShow(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const id = parsed.positionals[1]
  if (!id) return failure(output, 'Usage: diskpush fleet show RUN-ID', EXIT.usage)

  const run = await store.findFleetRun(id)
  if (!run) return failure(output, `No fleet run matching ${JSON.stringify(id)}.`, EXIT.configuration)
  const hosts = await store.listFleetRunHosts(run.id)

  if (output.isJson) {
    output.json({ status: 'ok', run, hosts })
    return EXIT.ok
  }

  output.line(`Run ${run.id}`)
  output.line(`${run.label}  ·  ${run.state}  ·  ${run.createdAt.slice(0, 19).replace('T', ' ')}`)
  output.line(`Selector: ${run.targetSelector.join(' ') || '-'}`)
  output.line()
  output.line(resultTable(hosts))

  // Full output only for the hosts that need explaining. Printing every
  // successful `apt upgrade` transcript is how this becomes unreadable.
  const failed = hosts.filter((host) => host.state !== 'succeeded')
  const wanted = hasFlag(parsed, '--all') ? hosts : failed
  for (const host of wanted) {
    output.line()
    output.line(`--- ${host.connectionName} (${host.host}) ${host.state} ---`)
    if (host.stdout.trim()) output.line(host.stdout.trimEnd())
    if (host.stderr.trim()) output.line(host.stderr.trimEnd())
  }
  if (failed.length === 0 && !hasFlag(parsed, '--all')) {
    output.line()
    output.line('Every server succeeded. Pass --all to print their output too.')
  }

  return EXIT.ok
}
