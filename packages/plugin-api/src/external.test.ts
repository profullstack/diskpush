import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PluginRegistry,
  addExternalPlugin,
  entryOf,
  installedPackages,
  loadExternalPlugins,
  removeExternalPlugin,
  type Npm,
} from './index.js'

const PLUGIN_SOURCE = (id: string) => `export default {
  id: ${JSON.stringify(id)},
  name: 'Hello',
  version: '0.1.0',
  description: 'says hello',
  commands: [{ name: 'hi', summary: 'hi', usage: 'hi', run: async () => 0 }],
}
`

function writePackage(dir: string, name: string, manifest: Record<string, unknown>, source: string) {
  const packageDir = join(dir, 'node_modules', name)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '0.1.0', type: 'module', ...manifest }))
  writeFileSync(join(packageDir, 'index.js'), source)
}

function project(dependencies: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'dp-plugins-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies }))
  return dir
}

/** npm, as far as these tests need it: edits package.json and node_modules. */
function fakeNpm(install: (dir: string, spec: string) => void): { npm: Npm; calls: string[][] } {
  const calls: string[][] = []
  const npm: Npm = async (args, cwd) => {
    calls.push(args)
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    const spec = args.at(-1)!
    if (args[0] === 'install') {
      install(cwd, spec)
      manifest.dependencies = { ...manifest.dependencies, [spec]: '^0.1.0' }
    } else {
      delete manifest.dependencies[spec]
      rmSync(join(cwd, 'node_modules', spec), { recursive: true, force: true })
    }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest))
  }
  return { npm, calls }
}

describe('external plugins', () => {
  it('loads only listed packages that declare themselves plugins, and reports the rest', async () => {
    const dir = project({ 'dp-hello': '^0.1.0', 'left-pad': '^1.0.0', missing: '^1.0.0' })
    writePackage(dir, 'dp-hello', { diskpush: { apiVersion: 1 } }, PLUGIN_SOURCE('hello'))
    writePackage(dir, 'left-pad', {}, 'export default {}')
    // Not in package.json, so never loaded however plugin-shaped it is.
    writePackage(dir, 'stray', { diskpush: {} }, PLUGIN_SOURCE('stray'))

    const registry = new PluginRegistry()
    const failures = await loadExternalPlugins(registry, dir)
    expect(registry.all().map((plugin) => plugin.id)).toEqual(['hello'])
    expect((await registry.list())[0]?.source).toBe('external')
    expect(failures.map((failure) => failure.name).sort()).toEqual(['left-pad', 'missing'])
    expect(failures.find((failure) => failure.name === 'left-pad')?.error).toMatch(/no "diskpush" field/)
  })

  it('is a no-op when nothing was ever installed', async () => {
    const registry = new PluginRegistry()
    expect(await loadExternalPlugins(registry, join(tmpdir(), 'dp-never-created'))).toEqual([])
  })

  it('refuses an entry point outside the package', () => {
    expect(() => entryOf('/p/node_modules/x', { name: 'x', main: '../../evil.js' })).toThrow(/leaves the package/)
    expect(entryOf('/p/node_modules/x', { exports: { '.': { import: './dist/i.js' } } })).toBe('/p/node_modules/x/dist/i.js')
  })

  it('adds with --ignore-scripts, and uninstalls a package that turns out not to be a plugin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-plugins-'))
    const good = fakeNpm((cwd, spec) => writePackage(cwd, spec, { diskpush: {} }, PLUGIN_SOURCE('hello')))
    const added = await addExternalPlugin(join(dir, 'plugins'), 'dp-hello', good.npm)
    expect(added.plugin.id).toBe('hello')
    expect(good.calls[0]).toContain('--ignore-scripts')
    expect(await installedPackages(join(dir, 'plugins'))).toEqual(['dp-hello'])

    const bad = fakeNpm((cwd, spec) => writePackage(cwd, spec, {}, 'export default {}'))
    await expect(addExternalPlugin(join(dir, 'plugins'), 'not-a-plugin', bad.npm)).rejects.toThrow(/not a DiskPush plugin/)
    expect(bad.calls.map((call) => call[0])).toEqual(['install', 'uninstall'])
    expect(await installedPackages(join(dir, 'plugins'))).toEqual(['dp-hello'])

    await removeExternalPlugin(join(dir, 'plugins'), 'dp-hello', good.npm)
    expect(await installedPackages(join(dir, 'plugins'))).toEqual([])
    await expect(addExternalPlugin(dir, '--global', good.npm)).rejects.toThrow(/cannot start/)
  })
})
