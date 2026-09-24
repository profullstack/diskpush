/**
 * Plugins that are not built in: npm packages installed into
 * `<diskpush home>/plugins`, which is a tiny npm project of its own.
 *
 *   ~/.config/diskpush/plugins/package.json       dependencies = installed plugins
 *   ~/.config/diskpush/plugins/node_modules/<pkg>  the code
 *
 * An external plugin is ordinary JavaScript running inside the CLI process or
 * the desktop app's main process, with every privilege the user has. Nothing
 * here sandboxes it, and nothing could: installing one is the same decision as
 * `npm install -g`. What this module does guarantee is narrower:
 *
 *   - only packages listed in that package.json are loaded, never a stray
 *     directory under node_modules;
 *   - a package must say it is a DiskPush plugin (`"diskpush": {...}` in its
 *     package.json), so installing a dependency by mistake loads nothing;
 *   - install runs with `--ignore-scripts`, so adding a plugin does not run
 *     code until DiskPush itself loads it;
 *   - one plugin failing to load is reported and skipped, never fatal.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PluginError, type PluginRegistry } from './registry.js'
import type { DiskpushPlugin } from './types.js'

export function pluginsDirectory(diskpushHome: string): string {
  return join(diskpushHome, 'plugins')
}

type Manifest = {
  name?: string
  version?: string
  main?: string
  exports?: unknown
  dependencies?: Record<string, string>
  diskpush?: unknown
}

async function readManifest(path: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** The names installed, from the plugins project's own package.json. */
export async function installedPackages(dir: string): Promise<string[]> {
  const manifest = await readManifest(join(dir, 'package.json'))
  return Object.keys(manifest?.dependencies ?? {}).sort()
}

/** The ESM entry of a package, from `exports` then `main`; refused if it points outside the package. */
export function entryOf(packageDir: string, manifest: Manifest): string {
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['.', 'import', 'node', 'default']) {
        const found = key in record ? pick(record[key]) : null
        if (found) return found
      }
    }
    return null
  }
  const target = pick(manifest.exports) ?? manifest.main ?? 'index.js'
  const full = resolve(packageDir, target)
  const rel = relative(packageDir, full)
  if (rel.startsWith('..') || rel.startsWith(sep) || resolve(full) === resolve(packageDir)) {
    throw new PluginError(`${manifest.name ?? packageDir}: its entry point leaves the package.`)
  }
  return full
}

export type LoadFailure = { name: string; error: string }

/**
 * Imports every installed plugin and registers it. Returns what failed, for
 * the caller to report however its surface reports things.
 */
export async function loadExternalPlugins(registry: PluginRegistry, dir: string): Promise<LoadFailure[]> {
  if (!existsSync(join(dir, 'package.json'))) return []
  const failures: LoadFailure[] = []
  for (const name of await installedPackages(dir)) {
    try {
      const plugin = await importPlugin(dir, name)
      registry.register(plugin, 'external', join(dir, 'node_modules', name))
    } catch (error) {
      failures.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return failures
}

export async function importPlugin(dir: string, name: string): Promise<DiskpushPlugin> {
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name)) throw new PluginError(`${name} is not a package name.`)
  const packageDir = join(dir, 'node_modules', name)
  const manifest = await readManifest(join(packageDir, 'package.json'))
  if (!manifest) throw new PluginError(`${name} is listed but not installed. Run: diskpush plugins add ${name}`)
  if (!manifest.diskpush || typeof manifest.diskpush !== 'object') {
    throw new PluginError(`${name} is not a DiskPush plugin: its package.json has no "diskpush" field.`)
  }
  const module = (await import(pathToFileURL(entryOf(packageDir, manifest)).href)) as {
    default?: unknown
    plugin?: unknown
  }
  const plugin = (module.default ?? module.plugin) as DiskpushPlugin | undefined
  if (!plugin || typeof plugin !== 'object') {
    throw new PluginError(`${name} does not export a plugin (default export, or \`export const plugin\`).`)
  }
  return plugin
}

export type Npm = (args: string[], cwd: string) => Promise<void>

/** Runs the npm on PATH. The desktop bundle carries no npm, so this is the CLI's. */
export const systemNpm: Npm = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' },
      (error, _stdout, stderr) => {
        if (!error) return resolvePromise()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') reject(new PluginError('Installing a plugin needs npm on your PATH.'))
        else reject(new PluginError(stderr.trim().split('\n').slice(-3).join('\n') || error.message))
      },
    )
  })

async function ensureProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'package.json')
  if (!existsSync(path)) {
    await writeFile(
      path,
      `${JSON.stringify({ name: 'diskpush-plugins', private: true, description: 'Plugins installed by `diskpush plugins add`.', dependencies: {} }, null, 2)}\n`,
    )
  }
}

/**
 * `diskpush plugins add <spec>`: installs a package and checks it is a plugin
 * that loads. One that does not is uninstalled again rather than left behind
 * to fail on every start.
 */
export async function addExternalPlugin(
  dir: string,
  spec: string,
  npm: Npm = systemNpm,
): Promise<{ name: string; plugin: DiskpushPlugin }> {
  if (spec.startsWith('-')) throw new PluginError('A package name cannot start with "-".')
  await ensureProject(dir)
  const before = new Set(await installedPackages(dir))
  await npm(['install', '--save', '--ignore-scripts', '--no-audit', '--no-fund', spec], dir)
  const added = (await installedPackages(dir)).filter((name) => !before.has(name))
  const name = added[0] ?? spec.replace(/@[^@/]*$/, '')
  try {
    return { name, plugin: await importPlugin(dir, name) }
  } catch (error) {
    if (added.length > 0) await npm(['uninstall', '--save', name], dir).catch(() => {})
    throw error
  }
}

export async function removeExternalPlugin(dir: string, name: string, npm: Npm = systemNpm): Promise<void> {
  if (!(await installedPackages(dir)).includes(name)) throw new PluginError(`${name} is not an installed plugin.`)
  await npm(['uninstall', '--save', name], dir)
}
