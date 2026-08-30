import type { DiskPushStore } from '@diskpush/database'
import { parseEndpoint } from '@diskpush/rsync-core'
import { PresetNameSchema } from '@diskpush/schemas'
import { EXIT } from '../exit-codes.js'
import { table } from '../format.js'
import { failure, type Output } from '../output.js'
import { flagValue, type ParsedArgv } from '../parse-argv.js'
import { optionsFromFlags } from '../resolve.js'
import { runTransfer } from './transfer.js'

export async function runProfiles(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const subcommand = parsed.positionals[0] ?? 'list'

  switch (subcommand) {
    case 'list':
      return listProfiles(store, output)
    case 'show':
      return showProfile(parsed, store, output)
    case 'save':
    case 'add':
      return saveProfile(parsed, store, output)
    case 'remove':
    case 'rm':
      return removeProfile(parsed, store, output)
    case 'run':
      return runProfile(parsed, store, output)
    default:
      return failure(output, `Unknown subcommand ${JSON.stringify(subcommand)}. Try: list, show, save, remove, run.`, EXIT.usage)
  }
}

async function listProfiles(store: DiskPushStore, output: Output): Promise<number> {
  const profiles = await store.listProfiles()
  if (output.isJson) {
    output.json({ status: 'ok', profiles })
    return EXIT.ok
  }
  if (profiles.length === 0) {
    output.line('No sync profiles yet. Create one with: diskpush profiles save NAME SOURCE DESTINATION')
    return EXIT.ok
  }
  output.line(
    table(
      profiles.map((p) => [
        p.name,
        render(p.source),
        render(p.destination),
        p.preset,
        p.options.deleteMode === 'off' ? 'sync' : 'MIRROR',
      ]),
      ['NAME', 'SOURCE', 'DESTINATION', 'PRESET', 'MODE'],
    ),
  )
  return EXIT.ok
}

async function showProfile(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const name = parsed.positionals[1]
  if (!name) return failure(output, 'Usage: diskpush profiles show NAME', EXIT.usage)
  const profile = await store.findProfile(name)
  if (!profile) return failure(output, `No profile named ${JSON.stringify(name)}.`, EXIT.configuration)

  if (output.isJson) {
    output.json({ status: 'ok', profile })
    return EXIT.ok
  }
  output.line(`Name:        ${profile.name}`)
  output.line(`Source:      ${render(profile.source)}`)
  output.line(`Destination: ${render(profile.destination)}`)
  output.line(`Preset:      ${profile.preset}`)
  output.line(`Delete:      ${profile.options.deleteMode === 'off' ? 'Off' : profile.options.deleteMode}`)
  if (profile.options.excludes.length > 0) {
    output.line('Exclude:')
    for (const exclude of profile.options.excludes) output.line(`  ${exclude}`)
  }
  return EXIT.ok
}

async function saveProfile(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const [, name, source, destination] = parsed.positionals
  if (!name || !source || !destination) {
    return failure(output, 'Usage: diskpush profiles save NAME SOURCE DESTINATION [options]', EXIT.usage)
  }

  const presetFlag = flagValue(parsed, '--preset')
  const profile = await store.saveProfile({
    name,
    source: parseEndpoint(source),
    destination: parseEndpoint(destination),
    preset: presetFlag ? PresetNameSchema.parse(presetFlag) : 'fast-sync',
    options: optionsFromFlags(parsed),
    // A profile made here has no panes. 'left' is what the app will use when
    // it opens one: source on the left, the way you read it.
    sourcePane: 'left',
    // Never inherited from the command line: unattended mirroring has to be
    // turned on deliberately, in one place, after the fact.
    trustDeletes: false,
    schedule: { enabled: false, kind: 'daily', cron: null },
    watch: { enabled: false, debounceMs: 1000 },
    notifyOnSuccess: false,
    notifyOnFailure: true,
  })

  if (output.isJson) output.json({ status: 'ok', profile })
  else output.line(`Saved profile ${profile.name}.`)
  return EXIT.ok
}

async function removeProfile(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const name = parsed.positionals[1]
  if (!name) return failure(output, 'Usage: diskpush profiles remove NAME', EXIT.usage)
  const removed = await store.deleteProfile(name)
  if (!removed) return failure(output, `No profile named ${JSON.stringify(name)}.`, EXIT.configuration)
  if (output.isJson) output.json({ status: 'ok', removed: name })
  else output.line(`Removed profile ${name}.`)
  return EXIT.ok
}

async function runProfile(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const name = parsed.positionals[1]
  if (!name) return failure(output, 'Usage: diskpush profile run NAME', EXIT.usage)

  const profile = await store.findProfile(name)
  if (!profile) return failure(output, `No profile named ${JSON.stringify(name)}.`, EXIT.configuration)

  // Re-enter the transfer path with the profile's endpoints as positionals, so
  // a profile run and a bare command take exactly the same code path.
  const forwarded: ParsedArgv = {
    ...parsed,
    command: profile.options.deleteMode === 'off' ? 'sync' : 'mirror',
    positionals: [render(profile.source), render(profile.destination)],
    flags: new Map([...parsed.flags, ['--profile', [profile.name]]]),
  }
  return runTransfer(forwarded.command!, forwarded, store, output)
}

function render(endpoint: import('@diskpush/schemas').Endpoint): string {
  if (endpoint.type === 'local') return endpoint.path
  const prefix = endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host
  return `${prefix}:${endpoint.path}`
}
