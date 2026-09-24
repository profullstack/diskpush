/**
 * The plugin contract.
 *
 * A plugin is a plain object: an id, some metadata, and any of three kinds of
 * contribution -- commands for the CLI, file actions for the three file
 * browsers (the TUI, the desktop app, and `diskpush <plugin> ...` scripts),
 * and account tasks such as signing in. The host decides where each one is
 * drawn; the plugin only ever sees a context object, so the same code runs
 * under all three surfaces.
 *
 * Plugins run with the full privileges of the process that loads them: the
 * CLI process, or the desktop app's MAIN process. Never the renderer. See
 * docs/plugins.md for the security model.
 */

/** Bumped only on a breaking change to anything in this file. */
export const PLUGIN_API_VERSION = 1

export type Surface = 'cli' | 'tui' | 'desktop'

/** One entry the user picked, as the host found it on disk. */
export type EntryRef = {
  /** A bare name inside `ActionContext.dir`. Never a path. */
  name: string
  isDirectory: boolean
  /** Bytes, for a file. 0 for a directory. */
  size: number
}

/**
 * Where a plugin keeps its own configuration.
 *
 * Namespaced by the host under `plugin:<id>:`, in the same settings table the
 * CLI and the desktop app share, so a setting made in one surface is in force
 * in the other.
 */
export interface PluginSettings {
  get<T>(key: string, fallback: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
}

/**
 * Credentials: tokens, API keys.
 *
 * The same shape as settings but a separate store, so a host can protect it
 * differently and so a settings screen never has a reason to read one back.
 * `null` deletes.
 */
export interface PluginSecrets {
  get(key: string): Promise<string | null>
  set(key: string, value: string | null): Promise<void>
}

export type LogLevel = 'info' | 'warn' | 'error'

export type ProgressUpdate = {
  done?: number
  total?: number
  message?: string
  /** The file being worked on, relative to the action's directory. */
  currentFile?: string
}

/**
 * How a long action reports. The CLI draws it as a status line, the TUI in the
 * transfer panel, the desktop app in the transfer band.
 */
export interface ProgressSink {
  start(total?: number): void
  update(update: ProgressUpdate): void
  log(level: LogLevel, message: string): void
}

/** Everything any plugin code is handed, whichever surface is running it. */
export interface BaseContext {
  settings: PluginSettings
  secrets: PluginSecrets
  progress: ProgressSink
  /**
   * Opens a URL in the user's browser. http and https only; anything else is
   * refused by the host.
   */
  openUrl(url: string): Promise<void>
  /** Aborted when the user cancels. Long work must watch it. */
  signal: AbortSignal
  surface: Surface
  /** Environment variables, so a plugin can take an API key from one. */
  env: Readonly<Record<string, string | undefined>>
}

export interface ActionContext extends BaseContext {
  /** The absolute local directory the entries are in. */
  dir: string
  /** Bare entry names inside `dir`, validated by the host: no separators, no `..`. */
  names: string[]
  /** The same entries, as the host found them on disk. */
  entries: EntryRef[]
}

export type ActionResult = {
  ok: boolean
  /** One line, for a person: what happened. */
  message: string
  /** True when files under `dir` changed, so the listing should be read again. */
  changed?: boolean
}

/** Something a user does to selected local files. */
export interface FileAction {
  /** Unique within the plugin: `[a-z0-9-]+`. */
  id: string
  label: string
  description?: string
  /**
   * A single letter the TUI's actions menu answers to. Only a hint: the host
   * drops one that clashes with the menu's own keys or another action's.
   */
  tuiKey?: string
  /**
   * Whether this action makes sense for these entries, in `where.dir`. Must be
   * cheap and synchronous: it runs as a menu opens.
   */
  appliesTo(entries: readonly EntryRef[], where: { dir: string }): boolean
  run(ctx: ActionContext): Promise<ActionResult>
}

/**
 * Something that takes no files: signing in, signing out.
 *
 * The desktop app draws these as buttons in the plugin's settings. The CLI has
 * commands for the same things, so tasks are for the surfaces without a shell.
 */
export interface PluginTask {
  id: string
  label: string
  description?: string
  run(ctx: BaseContext): Promise<ActionResult>
}

export interface CommandContext extends BaseContext {
  surface: 'cli'
  /** The directory the command was run from. */
  cwd: string
  /** `--json` was given: print one JSON document to stdout and nothing else there. */
  json: boolean
  /** Normal output. Suppressed by `--quiet` and `--json`. */
  print(text: string): void
  /** Diagnostics, on stderr. */
  warn(text: string): void
  /** The machine-readable result. */
  printJson(value: unknown): void
  /** Asks a question on the terminal; null when there is no terminal to ask on. */
  prompt(question: string): Promise<string | null>
}

/** `diskpush <plugin-id> <name> [args...]` */
export interface PluginCommand {
  name: string
  summary: string
  /** One line: `analyze DIR [--sort]`. */
  usage: string
  /** Returns the process exit code. `args` excludes the plugin id and the command name. */
  run(args: string[], ctx: CommandContext): Promise<number>
}

/**
 * A setting a host can draw a control for.
 *
 * `secret` settings are write-only from a settings screen: the host stores them
 * with `PluginSecrets` and only ever reports whether one is set.
 */
export type SettingDef = {
  key: string
  label: string
  description?: string
  type: 'string' | 'enum' | 'boolean' | 'secret'
  /** For `enum`. */
  options?: string[]
  default?: string | boolean
}

export interface DiskpushPlugin {
  /** `[a-z][a-z0-9-]*`. It is also the CLI command: `diskpush <id> ...`. */
  id: string
  name: string
  version: string
  description: string
  /** The PLUGIN_API_VERSION this plugin was written against. Defaults to the current one. */
  apiVersion?: number
  commands?: PluginCommand[]
  actions?: FileAction[]
  tasks?: PluginTask[]
  settings?: SettingDef[]
  /** One line for a settings screen: "Signed in as ada@example.com". Null when there is nothing to say. */
  status?(ctx: BaseContext): Promise<string | null>
}
