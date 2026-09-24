/**
 * Plugins, hosted in the main process.
 *
 * Plugin code never runs in the renderer. The renderer asks, by id, for an
 * action on a directory plus bare entry names (validated by the contract);
 * this module runs it here and streams its progress back over
 * `plugins:progress`. A plugin gets the same context the CLI gives it, with
 * `openUrl` wired to the system browser for http(s) only.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { shell, type WebContents } from 'electron'
import { diskpushHome } from '@diskpush/database'
import {
  PluginError,
  PluginRegistry,
  describeEntries,
  loadExternalPlugins,
  pluginsDirectory,
  runAction,
  runTask,
  type ActionResult,
  type HostContext,
  type LoadFailure,
  type LogLevel,
  type ProgressSink,
  type SettingDef,
} from '@diskpush/plugin-api'
import { mediaAnalyzerPlugin } from '@diskpush/plugin-mediaanalyzer'
import { ExternalUrlSchema, IPC, type PluginActionRequest } from '../../shared/contract.js'
import { store } from './store.js'

/** The same built-in list as the CLI's (apps/cli/src/plugins.ts). */
const BUILTIN_PLUGINS = [mediaAnalyzerPlugin]

let loaded: Promise<{ registry: PluginRegistry; failures: LoadFailure[] }> | null = null

export function pluginRegistry(): Promise<{ registry: PluginRegistry; failures: LoadFailure[] }> {
  loaded ??= (async () => {
    const registry = new PluginRegistry(await store())
    for (const plugin of BUILTIN_PLUGINS) registry.register(plugin, 'builtin')
    const failures = await loadExternalPlugins(registry, pluginsDirectory(diskpushHome()))
    for (const failure of failures) console.warn(`plugin ${failure.name} did not load: ${failure.error}`)
    return { registry, failures }
  })()
  return loaded
}

/** What the renderer is told about a plugin. Code stays here. */
export type PluginSummary = {
  id: string
  name: string
  version: string
  description: string
  source: 'builtin' | 'external'
  enabled: boolean
  settings: SettingDef[]
  tasks: { id: string; label: string; description: string }[]
  actions: { id: string; label: string; description: string }[]
}

export async function listPlugins(): Promise<{ plugins: PluginSummary[]; failures: LoadFailure[] }> {
  const { registry, failures } = await pluginRegistry()
  const plugins = (await registry.list()).map(({ plugin, source, enabled }) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    source,
    enabled,
    settings: plugin.settings ?? [],
    tasks: (plugin.tasks ?? []).map(({ id, label, description }) => ({ id, label, description: description ?? '' })),
    actions: (plugin.actions ?? []).map(({ id, label, description }) => ({ id, label, description: description ?? '' })),
  }))
  return { plugins, failures }
}

/** `~` expanded here, never trusted from the renderer; the result must be absolute. */
function localDirectory(input: string): string {
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  const dir = resolve(expanded)
  if (!isAbsolute(dir)) throw new PluginError('A plugin works on an absolute local directory.')
  return dir
}

export type PluginActionChoice = { pluginId: string; pluginName: string; actionId: string; label: string; description: string }

export async function pluginActionsFor(input: { dir: string; names: string[] }): Promise<PluginActionChoice[]> {
  const { registry } = await pluginRegistry()
  const dir = localDirectory(input.dir)
  const entries = await describeEntries(dir, input.names)
  return (await registry.actionsFor(entries, dir)).map(({ plugin, action }) => ({
    pluginId: plugin.id,
    pluginName: plugin.name,
    actionId: action.id,
    label: action.label,
    description: action.description ?? '',
  }))
}

/** Every event on `plugins:progress`. */
export type PluginEvent =
  | { type: 'start'; total: number | null }
  | { type: 'update'; done?: number; total?: number; message?: string; currentFile?: string }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'exit'; ok: boolean; message: string; changed: boolean; cancelled: boolean }

const running = new Map<string, AbortController>()

function sink(jobId: string, sender: WebContents): ProgressSink {
  // The window can close mid-run; the plugin carries on and its files are
  // still written.
  const send = (event: PluginEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC.eventPlugin, { jobId, event })
  }
  return {
    start: (total) => send({ type: 'start', total: total ?? null }),
    update: (update) => send({ type: 'update', ...update }),
    log: (level, message) => send({ type: 'log', level, message }),
  }
}

async function openUrl(url: string): Promise<void> {
  await shell.openExternal(ExternalUrlSchema.parse(url))
}

/** Starts `work` under a fresh AbortController, reports its outcome, and returns at once. */
function launch(jobId: string, sender: WebContents, work: (host: HostContext) => Promise<ActionResult>): { jobId: string } {
  if (running.has(jobId)) throw new PluginError('That job id is already running.')
  const controller = new AbortController()
  running.set(jobId, controller)
  const progress = sink(jobId, sender)
  const host: HostContext = { progress, openUrl, signal: controller.signal, surface: 'desktop', env: process.env }
  void (async () => {
    let result: ActionResult
    try {
      result = await work(host)
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      running.delete(jobId)
    }
    const cancelled = controller.signal.aborted
    if (!sender.isDestroyed()) {
      sender.send(IPC.eventPlugin, {
        jobId,
        event: {
          type: 'exit',
          ok: result.ok && !cancelled,
          message: cancelled ? 'Cancelled. What finished before that is kept.' : result.message,
          changed: result.changed === true,
          cancelled,
        } satisfies PluginEvent,
      })
    }
  })()
  return { jobId }
}

export async function runPluginAction(request: PluginActionRequest, sender: WebContents): Promise<{ jobId: string }> {
  const { registry } = await pluginRegistry()
  // Checked before returning, so an unknown or disabled plugin is an error
  // on the call rather than an event the renderer has to be waiting for.
  await registry.action(request.pluginId, request.actionId)
  const dir = localDirectory(request.dir)
  return launch(request.jobId, sender, (host) =>
    runAction(registry, request.pluginId, request.actionId, { ...host, dir, names: request.names }),
  )
}

export async function runPluginTask(
  request: { jobId: string; pluginId: string; taskId: string },
  sender: WebContents,
): Promise<{ jobId: string }> {
  const { registry } = await pluginRegistry()
  await registry.task(request.pluginId, request.taskId)
  return launch(request.jobId, sender, (host) => runTask(registry, request.pluginId, request.taskId, host))
}

export function cancelPlugin(jobId: string): boolean {
  const controller = running.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * A plugin's settings for the dialog. Secrets are reported as set or not,
 * never returned: the renderer is the one place a token must not reach.
 */
export async function getPluginSettings(pluginId: string): Promise<{
  status: string | null
  values: Record<string, string | boolean>
  secrets: Record<string, boolean>
}> {
  const { registry } = await pluginRegistry()
  const plugin = registry.get(pluginId)
  if (!plugin) throw new PluginError(`No plugin called "${pluginId}".`)
  const settings = registry.settingsFor(pluginId)
  const secrets = registry.secretsFor(pluginId)
  const values: Record<string, string | boolean> = {}
  const set: Record<string, boolean> = {}
  for (const def of plugin.settings ?? []) {
    if (def.type === 'secret') set[def.key] = (await secrets.get(def.key)) !== null
    else values[def.key] = await settings.get(def.key, def.default ?? (def.type === 'boolean' ? false : ''))
  }
  let status: string | null = null
  if (plugin.status && (await registry.isEnabled(pluginId))) {
    try {
      status = await plugin.status({
        settings,
        secrets,
        progress: { start() {}, update() {}, log() {} },
        openUrl,
        signal: AbortSignal.timeout(10_000),
        surface: 'desktop',
        env: process.env,
      })
    } catch (error) {
      status = error instanceof Error ? error.message : String(error)
    }
  }
  return { status, values, secrets: set }
}

/** Writes declared settings only, each checked against its declared type. */
export async function setPluginSettings(pluginId: string, values: Record<string, string | boolean | null>): Promise<boolean> {
  const { registry } = await pluginRegistry()
  const plugin = registry.get(pluginId)
  if (!plugin) throw new PluginError(`No plugin called "${pluginId}".`)
  const defs = new Map((plugin.settings ?? []).map((def) => [def.key, def]))
  for (const [key, value] of Object.entries(values)) {
    const def = defs.get(key)
    if (!def) throw new PluginError(`${plugin.name} has no setting "${key}".`)
    if (def.type === 'secret') {
      if (value !== null && typeof value !== 'string') throw new PluginError(`${def.label} must be text.`)
      await registry.secretsFor(pluginId).set(key, value === '' ? null : value)
      continue
    }
    if (def.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') {
      throw new PluginError(`${def.label} has the wrong type.`)
    }
    if (def.type === 'enum' && !(def.options ?? []).includes(value as string)) {
      throw new PluginError(`${def.label} must be one of: ${(def.options ?? []).filter(Boolean).join(', ')}.`)
    }
    await registry.settingsFor(pluginId).set(key, value)
  }
  return true
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
  const { registry } = await pluginRegistry()
  await registry.setEnabled(pluginId, enabled)
  return enabled
}
