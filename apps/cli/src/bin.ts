#!/usr/bin/env node
import { DiskPushStore } from '@diskpush/database'
import { EndpointParseError } from '@diskpush/rsync-core'
import { ZodError } from 'zod'
import { runConnections } from './commands/connections.js'
import { runJob, runJobs, runRetry } from './commands/jobs.js'
import { runLs } from './commands/ls.js'
import { runProfiles } from './commands/profiles.js'
import { runTransfer, TRANSFER_ALIASES } from './commands/transfer.js'
import { EXIT } from './exit-codes.js'
import { HELP, VERSION } from './help.js'
import { Output } from './output.js'
import { ArgvError, hasFlag, looksLikeEndpoint, parseArgv } from './parse-argv.js'
import { existsSync } from 'node:fs'

async function main(argv: readonly string[]): Promise<number> {
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
    process.stdout.write(HELP)
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
      case 'ls':
        return await runLs(parsed, store, output)
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
