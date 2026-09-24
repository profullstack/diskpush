/**
 * Plugins, as the CLI and the TUI host them.
 *
 * Built-in plugins are imported here, so they ship inside the CLI bundle with
 * nothing to install. External ones are loaded from `<diskpush home>/plugins`
 * (see @diskpush/plugin-api's external.ts); they run in this process, with
 * the user's privileges, exactly like the CLI itself.
 */
import { spawn } from 'node:child_process'
import { diskpushHome } from '@diskpush/database'
import {
  PluginRegistry,
  loadExternalPlugins,
  memoryBackend,
  pluginsDirectory,
  runAction,
  type ActionResult,
  type EntryRef,
  type LoadFailure,
  type ProgressSink,
  type SettingsBackend,
} from '@diskpush/plugin-api'
import { mediaAnalyzerPlugin } from '@diskpush/plugin-mediaanalyzer'

/** Plugins that ship with DiskPush. */
export const BUILTIN_PLUGINS = [mediaAnalyzerPlugin]

export type LoadedRegistry = { registry: PluginRegistry; failures: LoadFailure[] }

/**
 * Every plugin this process can run. `backend` is the store; without one (the
 * help text) enabled state is not known and everything reads as enabled.
 */
export async function loadPlugins(
  backend: SettingsBackend | null,
  options: { external?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedRegistry> {
  const registry = new PluginRegistry(backend ?? memoryBackend())
  for (const plugin of BUILTIN_PLUGINS) registry.register(plugin, 'builtin')
  const failures =
    options.external === false ? [] : await loadExternalPlugins(registry, pluginsDirectory(diskpushHome(options.env)))
  return { registry, failures }
}

/**
 * Opens a URL in the browser. http(s) only: a plugin must not be able to
 * hand the desktop opener a file path or a custom scheme.
 */
export async function openExternal(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs can be opened.')
  const argv =
    platform === 'darwin' ? ['open', url] : platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
  await new Promise<void>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' })
    // No opener is not fatal: every caller prints the URL too.
    child.on('error', () => resolve())
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** One action a menu can offer, flattened for drawing. */
export type ActionChoice = {
  pluginId: string
  pluginName: string
  actionId: string
  label: string
  description: string
  key: string | null
}

/** What the TUI needs from plugins, so the TUI can be tested with a fake. */
export interface PluginHost {
  actionsFor(dir: string, entries: readonly EntryRef[]): Promise<ActionChoice[]>
  run(
    choice: ActionChoice,
    dir: string,
    names: readonly string[],
    progress: ProgressSink,
    signal: AbortSignal,
  ): Promise<ActionResult>
}

/** The keys the actions menu keeps for itself. */
const MENU_KEYS = new Set(['j', 'k', 'q'])

/**
 * The menu's letters: each action's `tuiKey` hint, when it is free. A clash
 * with the menu's own keys or an earlier action loses its letter, not its row.
 */
export function assignKeys(choices: Omit<ActionChoice, 'key'>[], hints: (string | undefined)[]): ActionChoice[] {
  const used = new Set(MENU_KEYS)
  return choices.map((choice, index) => {
    const hint = hints[index]
    const key = hint && !used.has(hint) ? hint : null
    if (key) used.add(key)
    return { ...choice, key }
  })
}

export function registryHost(registry: PluginRegistry, env: NodeJS.ProcessEnv = process.env): PluginHost {
  return {
    async actionsFor(dir, entries) {
      const matches = await registry.actionsFor(entries, dir)
      return assignKeys(
        matches.map(({ plugin, action }) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          actionId: action.id,
          label: action.label,
          description: action.description ?? '',
        })),
        matches.map(({ action }) => action.tuiKey),
      )
    },
    run(choice, dir, names, progress, signal) {
      return runAction(registry, choice.pluginId, choice.actionId, {
        dir,
        names,
        progress,
        signal,
        surface: 'tui',
        env,
        openUrl: (url) => openExternal(url),
      })
    },
  }
}
