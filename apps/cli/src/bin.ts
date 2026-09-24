#!/usr/bin/env node
import { DiskPushStore } from '@diskpush/database'
import { EndpointParseError } from '@diskpush/rsync-core'
import { ZodError } from 'zod'
import { runConnections } from './commands/connections.js'
import { runFleetCommand } from './commands/fleet.js'
import { runJob, runJobs, runRetry } from './commands/jobs.js'
import { runDoctor, runUninstall, runUpdate } from './commands/self.js'
import { runDesktop } from './commands/desktop.js'
import { runTui } from './commands/tui.js'
import { runLs } from './commands/ls.js'
import { runProfiles } from './commands/profiles.js'
import { runTransfer, TRANSFER_ALIASES } from './commands/transfer.js'
import { EXIT } from './exit-codes.js'
import { HELP, VERSION } from './help.js'
import { Output } from './output.js'
import { ArgvError, hasFlag, isKnownCommand, looksLikeEndpoint, parseArgv } from './parse-argv.js'
import { autoUpdate, reexec } from './self-update.js'
import { findPluginCall, runPluginCommand, runPlugins } from './commands/plugins.js'
import { pluginHelp } from './help.js'
import { loadPlugins } from './plugins.js'
import { PluginError } from '@diskpush/plugin-api'
import { existsSync } from 'node:fs'

/** A first word that is neither a command nor a path might be a plugin: `diskpush mediaanalyzer login`. */
function mightBePlugin(argv: readonly string[]): boolean {
  const head = argv.find((token) => !token.startsWith('-'))
  return head !== undefined && /^[a-z][a-z0-9-]*$/.test(head) && !isKnownCommand(head) && !looksLikeEndpoint(head, existsSync)
}

async function runPlugin(argv: readonly string[]): Promise<number | null> {
  const store = await DiskPushStore.open()
  try {
    const { registry, failures } = await loadPlugins(store)
    const call = findPluginCall(argv, registry)
    if (!call) return null
    const output = new Output({
      json: argv.includes('--json'),
      quiet: argv.includes('--quiet') || argv.includes('-q'),
      progress: !argv.includes('--no-progress'),
    })
    for (const { name, error } of failures) output.warn(`plugin ${name} did not load: ${error}`)
    if (await autoUpdate(call.pluginId, output) === 'updated') reexec()
    return await runPluginCommand(registry, call.pluginId, call.args, output)
  } catch (error) {
    if (error instanceof PluginError) {
      process.stderr.write(`${error.message}\n`)
      return EXIT.configuration
    }
    throw error
  } finally {
    await store.close()
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (mightBePlugin(argv)) {
    const code = await runPlugin(argv)
    if (code !== null) return code
  }

  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return EXIT.usage
  }

  const output = new Output({
    json: hasFlag(parsed, '--json'),
    quiet: hasFlag(parsed, '--quiet'),
    progress: !hasFlag(parsed, '--no-progress'),
  })

  if (hasFlag(parsed, '--help') || parsed.command === 'help') {
    process.stdout.write(HELP + pluginHelp((await loadPlugins(null)).registry.all()))
    return EXIT.ok
  }
  if (hasFlag(parsed, '--version') || parsed.command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return EXIT.ok
  }

  // The bare `diskpush SOURCE DESTINATION` form, but only when both arguments
  // actually look like endpoints. Otherwise a mistyped subcommand would be
  // read as a transfer between two files named after it.
  const bareEndpoints =
    parsed.positionals.length >= 2 && parsed.positionals.slice(0, 2).every((value) => looksLikeEndpoint(value, existsSync))

  const command = parsed.command ?? (bareEndpoints ? 'sync' : null)
  if (!command) {
    if (parsed.positionals.length > 0) {
      output.error(
        `Unknown command ${JSON.stringify(parsed.positionals[0])}.\n` +
          'If you meant to transfer between two paths, write them as paths ' +
          '(./src/, /srv/app/, host:/srv/app/). Run `diskpush --help` for the command list.',
      )
      return EXIT.usage
    }
    process.stdout.write(HELP)
    return EXIT.ok
  }

  // Check for a newer release before running the command, so it runs on the
  // version just installed. Rate-limited, silent when offline, and skipped
  // entirely for --json, for the self-management commands, and when
  // DISKPUSH_NO_AUTO_UPDATE is set.
  if (await autoUpdate(command, output) === 'updated') reexec()

  const store = await DiskPushStore.open()
  try {
    if (command in TRANSFER_ALIASES) return await runTransfer(command, parsed, store, output)
    switch (command) {
      case 'connections':
        return await runConnections(parsed, store, output)
      case 'profiles':
      case 'profile':
        return await runProfiles(parsed, store, output)
      case 'jobs':
        return await runJobs(parsed, store, output)
      case 'job':
        return await runJob(parsed, store, output)
      case 'retry':
        return await runRetry(parsed, store, output)
      case 'update':
      case 'upgrade':
        return await runUpdate(parsed, output)
      case 'uninstall':
      case 'remove':
        return await runUninstall(parsed, output)
      case 'doctor':
        return await runDoctor(parsed, output)
      case 'desktop':
        return await runDesktop(parsed, output)
      case 'tui':
        return await runTui(parsed, store, output)
      case 'fleet':
        return await runFleetCommand(parsed, store, output)
      case 'ls':
        return await runLs(parsed, store, output)
      case 'plugins':
      case 'plugin':
        return await runPlugins(parsed, store, output)
      default:
        output.error(`Unknown command ${JSON.stringify(command)}. Run \`diskpush --help\`.`)
        return EXIT.usage
    }
  } finally {
    await store.close()
  }
}

function describeError(error: unknown): { message: string; code: number } {
  if (error instanceof ArgvError) return { message: error.message, code: EXIT.usage }
  if (error instanceof EndpointParseError) return { message: error.message, code: EXIT.usage }
  if (error instanceof PluginError) return { message: error.message, code: EXIT.configuration }
  if (error instanceof ZodError) {
    const first = error.issues[0]
    return {
      message: first ? `Invalid value at ${first.path.join('.') || '(root)'}: ${first.message}` : error.message,
      code: EXIT.usage,
    }
  }
  return { message: error instanceof Error ? error.message : String(error), code: EXIT.internal }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    const { message, code } = describeError(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = code
  })
