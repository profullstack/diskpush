import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiskPushStore } from '@diskpush/database'
import { PluginRegistry, definePlugin, memoryBackend, type CommandContext } from '@diskpush/plugin-api'
import { Output } from '../output.js'
import { parseArgv } from '../parse-argv.js'
import { pluginHelp } from '../help.js'
import { assignKeys, loadPlugins } from '../plugins.js'
import { findPluginCall, runPluginCommand, runPlugins, stripGlobalFlags } from './plugins.js'

const seen: { args: string[]; ctx: CommandContext }[] = []

const echo = definePlugin({
  id: 'echo',
  name: 'Echo',
  version: '1.0.0',
  description: 'repeats itself',
  commands: [
    {
      name: 'say',
      summary: 'print the arguments',
      usage: 'say WORDS... [--loud]',
      async run(args, ctx) {
        seen.push({ args, ctx })
        await ctx.settings.set('last', args)
        if (ctx.json) ctx.printJson({ said: args })
        else ctx.print(args.join(' '))
        return args.includes('--fail') ? 3 : 0
      },
    },
  ],
})

let stdout: string[]
let stderr: string[]

beforeEach(() => {
  seen.length = 0
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const output = (json = false) => new Output({ json, quiet: false, progress: false })

function registry() {
  const r = new PluginRegistry(memoryBackend())
  r.register(echo)
  return r
}

describe('dispatch to a plugin', () => {
  it('finds `diskpush <plugin-id> ...` on raw argv, flags before the id included', () => {
    const r = registry()
    expect(findPluginCall(['echo', 'say', 'hi'], r)).toEqual({ pluginId: 'echo', args: ['say', 'hi'] })
    expect(findPluginCall(['--json', 'echo', 'say', '--timeout'], r)).toEqual({
      pluginId: 'echo',
      args: ['--json', 'say', '--timeout'],
    })
    expect(findPluginCall(['sync', './a', './b'], r)).toBeNull()
    expect(findPluginCall(['--help'], r)).toBeNull()
    expect(stripGlobalFlags(['--json', 'say', '-q', 'x'])).toEqual(['say', 'x'])
  })

  it('runs the command with its own arguments and a context bound to the plugin', async () => {
    const r = registry()
    const code = await runPluginCommand(r, 'echo', ['say', 'hello', 'world', '--loud'], output())
    expect(code).toBe(0)
    expect(seen[0]!.args).toEqual(['hello', 'world', '--loud'])
    expect(seen[0]!.ctx.surface).toBe('cli')
    expect(stdout.join('')).toBe('hello world --loud\n')
    expect(await r.backend.getSetting('plugin:echo:last', null)).toEqual(['hello', 'world', '--loud'])
  })

  it('passes the exit code through, and --json reaches the plugin as ctx.json', async () => {
    const r = registry()
    expect(await runPluginCommand(r, 'echo', ['--json', 'say', 'x', '--fail'], output(true))).toBe(3)
    expect(seen[0]!.ctx.json).toBe(true)
    expect(JSON.parse(stdout.join(''))).toEqual({ said: ['x', '--fail'] })
  })

  it('prints the plugin help for no command, and refuses an unknown one', async () => {
    const r = registry()
    expect(await runPluginCommand(r, 'echo', [], output())).toBe(64)
    expect(stdout.join('')).toContain('diskpush echo say WORDS... [--loud]')
    expect(await runPluginCommand(r, 'echo', ['shout'], output())).toBe(64)
    expect(stderr.join('')).toContain('Echo has no command "shout"')
  })

  it('will not run a disabled plugin', async () => {
    const r = registry()
    await r.disable('echo')
    await expect(runPluginCommand(r, 'echo', ['say'], output())).rejects.toThrow(/disabled.*diskpush plugins enable echo/)
  })

  it('lists plugin commands in the help text', () => {
    expect(pluginHelp([echo])).toContain('PLUGIN COMMANDS\n  echo say WORDS... [--loud]  print the arguments')
    expect(pluginHelp([])).toBe('')
  })
})

describe('diskpush plugins', () => {
  it('lists the built-in plugins, and enable/disable persist in the store', async () => {
    vi.stubEnv('DISKPUSH_HOME', mkdtempSync(join(tmpdir(), 'dp-home-')))
    const store = await DiskPushStore.open({ path: ':memory:' })
    try {
      expect(await runPlugins(parseArgv(['plugins']), store, output())).toBe(0)
      expect(stdout.join('')).toMatch(/mediaanalyzer\s+enabled\s+builtin/)
      expect(stdout.join('')).toContain('diskpush mediaanalyzer analyze DIR [--sort]')

      expect(await runPlugins(parseArgv(['plugins', 'disable', 'mediaanalyzer']), store, output())).toBe(0)
      expect(await store.getSetting('plugins.disabled', [])).toEqual(['mediaanalyzer'])
      const { registry: again } = await loadPlugins(store)
      expect(await again.isEnabled('mediaanalyzer')).toBe(false)

      expect(await runPlugins(parseArgv(['plugins', 'enable', 'mediaanalyzer']), store, output())).toBe(0)
      expect(await store.getSetting('plugins.disabled', [])).toEqual([])

      expect(await runPlugins(parseArgv(['plugins', 'enable', 'nope']), store, output())).toBe(65)
      expect(await runPlugins(parseArgv(['plugins', 'remove', 'mediaanalyzer']), store, output())).toBe(66)
    } finally {
      await store.close()
    }
  })
})

describe('action keys', () => {
  it('keeps each hinted letter unless the menu or an earlier action has it', () => {
    const choice = (label: string) => ({ pluginId: 'p', pluginName: 'P', actionId: label, label, description: '' })
    const keys = assignKeys([choice('a'), choice('b'), choice('c'), choice('d')], ['m', 'm', 'j', undefined]).map((c) => c.key)
    expect(keys).toEqual(['m', null, null, null])
  })
})
