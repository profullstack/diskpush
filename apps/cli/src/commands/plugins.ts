import { createInterface } from 'node:readline/promises'
import type { DiskPushStore } from '@diskpush/database'
import { diskpushHome } from '@diskpush/database'
import {
  addExternalPlugin,
  pluginsDirectory,
  removeExternalPlugin,
  type CommandContext,
  type DiskpushPlugin,
  type PluginRegistry,
  type ProgressSink,
} from '@diskpush/plugin-api'
import { EXIT } from '../exit-codes.js'
import { failure, type Output } from '../output.js'
import { type ParsedArgv } from '../parse-argv.js'
import { loadPlugins, openExternal } from '../plugins.js'

/**
 * `diskpush plugins` — what is installed, and turning it on and off.
 *
 *   diskpush plugins                  list, with each plugin's commands
 *   diskpush plugins enable ID
 *   diskpush plugins disable ID
 *   diskpush plugins add NPM-PACKAGE  install an external plugin (runs with your privileges)
 *   diskpush plugins remove ID
 */
export async function runPlugins(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const [sub = 'list', target] = parsed.positionals
  const { registry, failures } = await loadPlugins(store)

  switch (sub) {
    case 'list':
    case 'ls': {
      const list = await registry.list()
      if (output.isJson) {
        output.json({
          plugins: list.map(({ plugin, source, enabled, location }) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            source,
            enabled,
            ...(location ? { location } : {}),
            commands: (plugin.commands ?? []).map((command) => command.name),
            actions: (plugin.actions ?? []).map((action) => action.id),
          })),
          failures,
        })
        return EXIT.ok
      }
      for (const { plugin, source, enabled } of list) {
        output.line(`${plugin.id.padEnd(16)} ${enabled ? 'enabled ' : 'disabled'}  ${source.padEnd(8)}  ${plugin.name} ${plugin.version}`)
        output.line(`${''.padEnd(16)} ${plugin.description}`)
        for (const command of plugin.commands ?? []) output.line(`${''.padEnd(18)}diskpush ${plugin.id} ${command.usage}`)
      }
      for (const { name, error } of failures) output.warn(`could not load ${name}: ${error}`)
      return EXIT.ok
    }
    case 'enable':
    case 'disable': {
      if (!target) return failure(output, `usage: diskpush plugins ${sub} ID`, EXIT.usage)
      if (!registry.has(target)) return failure(output, `No plugin called "${target}". See: diskpush plugins`, EXIT.configuration)
      await registry.setEnabled(target, sub === 'enable')
      if (output.isJson) output.json({ id: target, enabled: sub === 'enable' })
      else output.line(`${target} ${sub}d.`)
      return EXIT.ok
    }
    case 'add':
    case 'install': {
      if (!target) return failure(output, 'usage: diskpush plugins add NPM-PACKAGE', EXIT.usage)
      output.warn(
        `A plugin runs inside DiskPush with your full privileges: it can read, change and send any file you can.\n` +
          `Only add one you would run as a program. Installing ${target}…`,
      )
      const added = await addExternalPlugin(pluginsDirectory(diskpushHome()), target)
      if (output.isJson) output.json({ package: added.name, id: added.plugin.id })
      else output.line(`Added ${added.plugin.name} (${added.plugin.id}) from ${added.name}.`)
      return EXIT.ok
    }
    case 'remove':
    case 'uninstall': {
      if (!target) return failure(output, 'usage: diskpush plugins remove ID', EXIT.usage)
      const info = (await registry.list()).find((entry) => entry.plugin.id === target)
      if (info?.source === 'builtin') {
        return failure(output, `${target} is built in; turn it off with: diskpush plugins disable ${target}`, EXIT.refused)
      }
      // By plugin id when it loaded, else by the package name it was added as.
      const packageName = info?.location?.split('node_modules/').at(-1) ?? target
      await removeExternalPlugin(pluginsDirectory(diskpushHome()), packageName)
      output.line(`Removed ${packageName}.`)
      return EXIT.ok
    }
    default:
      return failure(output, `Unknown plugins command "${sub}". Use list, enable, disable, add or remove.`, EXIT.usage)
  }
}

/** A plugin's own help: its commands, one per line. */
export function pluginUsage(plugin: DiskpushPlugin): string {
  const lines = [`${plugin.name} ${plugin.version} - ${plugin.description}`, '', 'COMMANDS']
  const width = Math.max(0, ...(plugin.commands ?? []).map((command) => command.usage.length))
  for (const command of plugin.commands ?? []) {
    lines.push(`  diskpush ${plugin.id} ${command.usage.padEnd(width)}  ${command.summary}`)
  }
  return `${lines.join('\n')}\n`
}

/** Draws plugin progress on the one status line the CLI has. */
export function outputProgress(output: Output): ProgressSink & { finish(): void } {
  let total: number | undefined
  let last = ''
  return {
    start(count) {
      total = count
    },
    update({ done, total: newTotal, message, currentFile }) {
      if (newTotal !== undefined) total = newTotal
      const counter = done !== undefined && total ? `[${done}/${total}] ` : ''
      last = message ?? last
      output.status(`${counter}${currentFile ?? last}`)
    },
    log(level, message) {
      output.clearStatus()
      output.warn(level === 'info' ? message : `${level}: ${message}`)
    },
    finish() {
      output.clearStatus()
    },
  }
}

async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

/**
 * Whether argv is `diskpush [flags] <plugin-id> ...`, and if so which plugin
 * and what follows it. Decided on raw argv, before the CLI's own parser, so a
 * plugin's flags are the plugin's and never trip DiskPush's value flags.
 */
export function findPluginCall(
  argv: readonly string[],
  registry: Pick<PluginRegistry, 'has'>,
): { pluginId: string; args: string[] } | null {
  const at = argv.findIndex((token) => !token.startsWith('-'))
  if (at === -1) return null
  const head = argv[at]!
  if (!registry.has(head)) return null
  return { pluginId: head, args: [...argv.slice(0, at), ...argv.slice(at + 1)] }
}

/** Global flags the CLI owns; everything else belongs to the plugin. */
const GLOBAL_FLAGS = new Set(['--json', '--quiet', '-q', '--no-progress'])

export function stripGlobalFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !GLOBAL_FLAGS.has(arg))
}

/**
 * `diskpush <plugin-id> <command> [args...]`.
 *
 * Ctrl+C cancels through the context's signal, so a plugin can stop cleanly
 * and save its state; a second Ctrl+C exits at once.
 */
export async function runPluginCommand(
  registry: PluginRegistry,
  pluginId: string,
  argv: readonly string[],
  output: Output,
): Promise<number> {
  const plugin = await registry.require(pluginId)
  const args = stripGlobalFlags(argv)
  const [name, ...rest] = args
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(pluginUsage(plugin))
    return name ? EXIT.ok : EXIT.usage
  }
  const { command } = await registry.command(pluginId, name)
  if (!command) {
    output.error(`${plugin.name} has no command "${name}".\n`)
    process.stderr.write(pluginUsage(plugin))
    return EXIT.usage
  }

  const controller = new AbortController()
  let interrupts = 0
  const onInterrupt = () => {
    interrupts += 1
    if (interrupts > 1) process.exit(130)
    output.clearStatus()
    output.warn('Cancelling… (Ctrl+C again to quit now)')
    controller.abort()
  }
  process.on('SIGINT', onInterrupt)
  const progress = outputProgress(output)
  const ctx: CommandContext = {
    settings: registry.settingsFor(pluginId),
    secrets: registry.secretsFor(pluginId),
    progress,
    openUrl: (url) => openExternal(url),
    signal: controller.signal,
    surface: 'cli',
    env: process.env,
    cwd: process.cwd(),
    json: output.isJson,
    print: (text) => output.line(text),
    warn: (text) => output.warn(text),
    printJson: (value) => output.json(value),
    prompt: ask,
  }
  try {
    return await command.run(rest, ctx)
  } finally {
    progress.finish()
    process.off('SIGINT', onInterrupt)
  }
}
