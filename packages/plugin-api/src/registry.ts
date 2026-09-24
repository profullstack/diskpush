import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  PLUGIN_API_VERSION,
  type ActionContext,
  type ActionResult,
  type BaseContext,
  type DiskpushPlugin,
  type EntryRef,
  type FileAction,
  type PluginCommand,
  type PluginSecrets,
  type PluginSettings,
  type PluginTask,
} from './types.js'

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,39}$/
const PART_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

/** Ids the CLI already answers to; a plugin taking one could never be reached. */
export const RESERVED_IDS = new Set([
  'sync', 'push', 'pull', 'publish', 'deploy', 'backup', 'mirror', 'rsync', 'ls', 'connections', 'profiles',
  'profile', 'jobs', 'job', 'retry', 'update', 'upgrade', 'uninstall', 'remove', 'doctor', 'desktop', 'tui',
  'fleet', 'help', 'version', 'plugins', 'plugin',
])

export class PluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginError'
  }
}

/**
 * Checks a plugin's shape and returns it unchanged.
 *
 * Checked when it is defined rather than when it is first used, so a plugin
 * with a typo in an id fails its own tests instead of a user's menu.
 */
export function definePlugin<P extends DiskpushPlugin>(plugin: P): P {
  validatePlugin(plugin)
  return plugin
}

export function validatePlugin(plugin: DiskpushPlugin): void {
  if (!plugin || typeof plugin !== 'object') throw new PluginError('A plugin must be an object.')
  if (typeof plugin.id !== 'string' || !PLUGIN_ID.test(plugin.id)) {
    throw new PluginError(`Plugin id ${JSON.stringify(plugin.id)} must match ${PLUGIN_ID}.`)
  }
  if (RESERVED_IDS.has(plugin.id)) throw new PluginError(`Plugin id "${plugin.id}" is a DiskPush command.`)
  for (const field of ['name', 'version', 'description'] as const) {
    if (typeof plugin[field] !== 'string') throw new PluginError(`Plugin ${plugin.id} is missing ${field}.`)
  }
  const api = plugin.apiVersion ?? PLUGIN_API_VERSION
  if (api !== PLUGIN_API_VERSION) {
    throw new PluginError(
      `Plugin ${plugin.id} was written for plugin API ${api}; this DiskPush speaks ${PLUGIN_API_VERSION}.`,
    )
  }
  const unique = (kind: string, ids: string[], pattern = PART_ID) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (!pattern.test(id)) throw new PluginError(`Plugin ${plugin.id}: ${kind} id ${JSON.stringify(id)} is not valid.`)
      if (seen.has(id)) throw new PluginError(`Plugin ${plugin.id}: two ${kind}s are called "${id}".`)
      seen.add(id)
    }
  }
  unique('action', (plugin.actions ?? []).map((action) => action.id))
  unique('command', (plugin.commands ?? []).map((command) => command.name))
  unique('task', (plugin.tasks ?? []).map((task) => task.id))
  unique('setting', (plugin.settings ?? []).map((setting) => setting.key), SETTING_KEY)
  for (const action of plugin.actions ?? []) {
    if (typeof action.run !== 'function' || typeof action.appliesTo !== 'function') {
      throw new PluginError(`Plugin ${plugin.id}: action ${action.id} needs appliesTo() and run().`)
    }
    if (action.tuiKey !== undefined && !/^[a-z0-9]$/.test(action.tuiKey)) {
      throw new PluginError(`Plugin ${plugin.id}: action ${action.id} tuiKey must be one lowercase letter or digit.`)
    }
  }
}

/**
 * The part of the DiskPush store the registry needs. `DiskPushStore`
 * satisfies it as it is; a test can hand in a Map.
 */
export interface SettingsBackend {
  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>
}

/** A backend that forgets everything: for listing plugins where no store is open. */
export function memoryBackend(initial: Record<string, unknown> = {}): SettingsBackend {
  const values = new Map(Object.entries(initial))
  return {
    async getSetting<T>(key: string, fallback: T): Promise<T> {
      return values.has(key) ? (structuredClone(values.get(key)) as T) : fallback
    },
    async setSetting(key: string, value: unknown): Promise<void> {
      if (value === undefined) values.delete(key)
      else values.set(key, structuredClone(value))
    },
  }
}

/** Where a plugin's settings live in the shared table. */
export function settingKey(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`
}

export function secretKey(pluginId: string, key: string): string {
  return `plugin-secret:${pluginId}:${key}`
}

export function namespacedSettings(backend: SettingsBackend, pluginId: string): PluginSettings {
  return {
    get: (key, fallback) => backend.getSetting(settingKey(pluginId, key), fallback),
    set: (key, value) => backend.setSetting(settingKey(pluginId, key), value ?? null),
  }
}

/**
 * How a host protects secrets at rest. The desktop app could pass one backed
 * by Electron's safeStorage; the default stores them as they are, which is
 * what lets a sign-in made in the desktop app work in the CLI.
 */
export interface SecretCodec {
  encode(plain: string): string
  /** Null when the value cannot be read here: another machine's keychain, say. */
  decode(stored: string): string | null
}

export function namespacedSecrets(backend: SettingsBackend, pluginId: string, codec?: SecretCodec): PluginSecrets {
  return {
    async get(key) {
      const stored = await backend.getSetting<string | null>(secretKey(pluginId, key), null)
      if (typeof stored !== 'string' || stored === '') return null
      return codec ? codec.decode(stored) : stored
    },
    async set(key, value) {
      await backend.setSetting(secretKey(pluginId, key), value === null ? null : codec ? codec.encode(value) : value)
    },
  }
}

export type PluginSource = 'builtin' | 'external'

export type PluginInfo = {
  plugin: DiskpushPlugin
  source: PluginSource
  enabled: boolean
  /** Where an external plugin was loaded from. */
  location?: string
}

export type ActionMatch = { plugin: DiskpushPlugin; action: FileAction }

/** The settings key holding the ids of disabled plugins. */
export const DISABLED_KEY = 'plugins.disabled'

/**
 * Every plugin this process knows, and which of them the user has turned off.
 *
 * Built-in plugins are registered from code; external ones by
 * `loadExternalPlugins`. Disabled is the stored state rather than enabled, so
 * a newly installed plugin is on without a second step.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, { plugin: DiskpushPlugin; source: PluginSource; location?: string }>()

  constructor(
    readonly backend: SettingsBackend = memoryBackend(),
    private readonly codec?: SecretCodec,
  ) {}

  register(plugin: DiskpushPlugin, source: PluginSource = 'builtin', location?: string): void {
    validatePlugin(plugin)
    if (this.plugins.has(plugin.id)) throw new PluginError(`A plugin called "${plugin.id}" is already loaded.`)
    this.plugins.set(plugin.id, { plugin, source, ...(location ? { location } : {}) })
  }

  has(id: string): boolean {
    return this.plugins.has(id)
  }

  get(id: string): DiskpushPlugin | null {
    return this.plugins.get(id)?.plugin ?? null
  }

  /** Every plugin, enabled or not, in registration order. */
  all(): DiskpushPlugin[] {
    return [...this.plugins.values()].map((entry) => entry.plugin)
  }

  async disabledIds(): Promise<Set<string>> {
    const stored = await this.backend.getSetting<unknown>(DISABLED_KEY, [])
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  }

  async list(): Promise<PluginInfo[]> {
    const disabled = await this.disabledIds()
    return [...this.plugins.values()].map(({ plugin, source, location }) => ({
      plugin,
      source,
      enabled: !disabled.has(plugin.id),
      ...(location ? { location } : {}),
    }))
  }

  async isEnabled(id: string): Promise<boolean> {
    return this.plugins.has(id) && !(await this.disabledIds()).has(id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!this.plugins.has(id)) throw new PluginError(`No plugin called "${id}".`)
    const disabled = await this.disabledIds()
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    await this.backend.setSetting(DISABLED_KEY, [...disabled].sort())
  }

  enable(id: string): Promise<void> {
    return this.setEnabled(id, true)
  }

  disable(id: string): Promise<void> {
    return this.setEnabled(id, false)
  }

  /** The enabled plugin, or a PluginError saying why there is none. */
  async require(id: string): Promise<DiskpushPlugin> {
    const plugin = this.get(id)
    if (!plugin) throw new PluginError(`No plugin called "${id}". See: diskpush plugins list`)
    if (!(await this.isEnabled(id))) throw new PluginError(`The ${id} plugin is disabled. Turn it on with: diskpush plugins enable ${id}`)
    return plugin
  }

  /**
   * The actions of enabled plugins that apply to these entries.
   *
   * A plugin whose `appliesTo` throws is left out of the menu rather than
   * taking the menu down with it.
   */
  async actionsFor(entries: readonly EntryRef[], dir = ''): Promise<ActionMatch[]> {
    if (entries.length === 0) return []
    const disabled = await this.disabledIds()
    const matches: ActionMatch[] = []
    for (const { plugin } of this.plugins.values()) {
      if (disabled.has(plugin.id)) continue
      for (const action of plugin.actions ?? []) {
        try {
          if (action.appliesTo(entries, { dir })) matches.push({ plugin, action })
        } catch {
          // A broken plugin loses its menu item, not the user's menu.
        }
      }
    }
    return matches
  }

  async action(pluginId: string, actionId: string): Promise<{ plugin: DiskpushPlugin; action: FileAction }> {
    const plugin = await this.require(pluginId)
    const action = plugin.actions?.find((candidate) => candidate.id === actionId)
    if (!action) throw new PluginError(`The ${pluginId} plugin has no action "${actionId}".`)
    return { plugin, action }
  }

  async task(pluginId: string, taskId: string): Promise<{ plugin: DiskpushPlugin; task: PluginTask }> {
    const plugin = await this.require(pluginId)
    const task = plugin.tasks?.find((candidate) => candidate.id === taskId)
    if (!task) throw new PluginError(`The ${pluginId} plugin has no task "${taskId}".`)
    return { plugin, task }
  }

  async command(pluginId: string, name: string): Promise<{ plugin: DiskpushPlugin; command: PluginCommand | null }> {
    const plugin = await this.require(pluginId)
    return { plugin, command: plugin.commands?.find((candidate) => candidate.name === name) ?? null }
  }

  settingsFor(pluginId: string): PluginSettings {
    return namespacedSettings(this.backend, pluginId)
  }

  secretsFor(pluginId: string): PluginSecrets {
    return namespacedSecrets(this.backend, pluginId, this.codec)
  }
}

/** What a host supplies to build a context; the registry supplies settings and secrets. */
export type HostContext = Omit<BaseContext, 'settings' | 'secrets'>

export function baseContext(registry: PluginRegistry, pluginId: string, host: HostContext): BaseContext {
  return { ...host, settings: registry.settingsFor(pluginId), secrets: registry.secretsFor(pluginId) }
}

/**
 * A bare entry name: what the renderer and the TUI are allowed to hand over.
 *
 * The same rule as the desktop contract's EntryNameSchema, repeated here so a
 * host that forgets to validate still cannot walk a plugin out of `dir`.
 */
export function isEntryName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..'
  )
}

/**
 * The entries as they are on disk. Refuses anything but an absolute directory
 * and bare names, and drops names that no longer exist.
 */
export async function describeEntries(dir: string, names: readonly string[]): Promise<EntryRef[]> {
  if (!isAbsolute(dir)) throw new PluginError('A plugin action needs an absolute directory.')
  const out: EntryRef[] = []
  for (const name of names) {
    if (!isEntryName(name)) throw new PluginError(`${JSON.stringify(name)} is not a name inside ${dir}.`)
    try {
      const stats = await lstat(join(dir, name))
      if (stats.isSymbolicLink()) continue
      out.push({ name, isDirectory: stats.isDirectory(), size: stats.isDirectory() ? 0 : stats.size })
    } catch {
      // Gone since the listing was drawn.
    }
  }
  return out
}

export type RunActionOptions = HostContext & { dir: string; names: readonly string[] }

/**
 * Runs one action the way every host does: validate, describe, build the
 * context, and turn a throw into a failed result.
 */
export async function runAction(
  registry: PluginRegistry,
  pluginId: string,
  actionId: string,
  options: RunActionOptions,
): Promise<ActionResult> {
  const { action } = await registry.action(pluginId, actionId)
  const { dir, names, ...host } = options
  const entries = await describeEntries(dir, names)
  if (entries.length === 0) return { ok: false, message: 'Nothing selected exists any more.' }
  if (!action.appliesTo(entries, { dir })) return { ok: false, message: `${action.label} does not apply to that selection.` }
  const ctx: ActionContext = {
    ...baseContext(registry, pluginId, host),
    dir,
    names: entries.map((entry) => entry.name),
    entries,
  }
  try {
    return await action.run(ctx)
  } catch (error) {
    if (options.signal.aborted) return { ok: false, message: 'Cancelled.' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function runTask(
  registry: PluginRegistry,
  pluginId: string,
  taskId: string,
  host: HostContext,
): Promise<ActionResult> {
  const { task } = await registry.task(pluginId, taskId)
  try {
    return await task.run(baseContext(registry, pluginId, host))
  } catch (error) {
    if (host.signal.aborted) return { ok: false, message: 'Cancelled.' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** A progress sink that drops everything, for hosts that have nowhere to draw. */
export const silentProgress = {
  start() {},
  update() {},
  log() {},
}
