import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DISABLED_KEY,
  PluginRegistry,
  definePlugin,
  describeEntries,
  memoryBackend,
  runAction,
  silentProgress,
  type EntryRef,
} from './index.js'

const images = (entries: readonly EntryRef[]) => entries.every((entry) => entry.isDirectory || entry.name.endsWith('.jpg'))

function fake(id = 'fake', extra: Partial<Parameters<typeof definePlugin>[0]> = {}) {
  return definePlugin({
    id,
    name: 'Fake',
    version: '1.0.0',
    description: 'for tests',
    actions: [
      {
        id: 'count',
        label: 'Count',
        appliesTo: images,
        async run(ctx) {
          await ctx.settings.set('last', ctx.names)
          return { ok: true, message: `${ctx.entries.length} entries in ${ctx.dir}` }
        },
      },
      { id: 'everything', label: 'Everything', appliesTo: () => true, run: async () => ({ ok: true, message: 'ok' }) },
    ],
    ...extra,
  })
}

const host = () => ({
  progress: silentProgress,
  openUrl: async () => {},
  signal: new AbortController().signal,
  surface: 'cli' as const,
  env: {},
})

describe('definePlugin', () => {
  it('refuses ids that could never be reached or would collide', () => {
    expect(() => fake('Bad Id')).toThrow(/must match/)
    expect(() => fake('sync')).toThrow(/DiskPush command/)
    expect(() => fake('plugins')).toThrow(/DiskPush command/)
    expect(() =>
      fake('dupe', {
        actions: [
          { id: 'a', label: 'A', appliesTo: () => true, run: async () => ({ ok: true, message: '' }) },
          { id: 'a', label: 'A', appliesTo: () => true, run: async () => ({ ok: true, message: '' }) },
        ],
      }),
    ).toThrow(/two actions/)
  })

  it('refuses a plugin written for another API version', () => {
    expect(() => fake('old', { apiVersion: 99 })).toThrow(/plugin API 99/)
  })
})

describe('PluginRegistry', () => {
  it('lists plugins as enabled until one is disabled, and persists that in plugins.disabled', async () => {
    const backend = memoryBackend()
    const registry = new PluginRegistry(backend)
    registry.register(fake('one'))
    registry.register(fake('two'))
    expect((await registry.list()).map((info) => [info.plugin.id, info.enabled])).toEqual([
      ['one', true],
      ['two', true],
    ])

    await registry.disable('two')
    expect(await backend.getSetting(DISABLED_KEY, [])).toEqual(['two'])
    expect(await registry.isEnabled('two')).toBe(false)

    // A second registry over the same store sees the same state.
    const again = new PluginRegistry(backend)
    again.register(fake('two'))
    expect(await again.isEnabled('two')).toBe(false)

    await registry.enable('two')
    expect(await registry.isEnabled('two')).toBe(true)
    await expect(registry.disable('nope')).rejects.toThrow(/No plugin/)
  })

  it('refuses two plugins with one id', () => {
    const registry = new PluginRegistry()
    registry.register(fake())
    expect(() => registry.register(fake())).toThrow(/already loaded/)
  })

  it('offers only the actions that apply, from enabled plugins only', async () => {
    const registry = new PluginRegistry()
    registry.register(fake('one'))
    const jpg = [{ name: 'a.jpg', isDirectory: false, size: 1 }]
    const txt = [{ name: 'a.txt', isDirectory: false, size: 1 }]
    expect((await registry.actionsFor(jpg)).map((m) => m.action.id)).toEqual(['count', 'everything'])
    expect((await registry.actionsFor(txt)).map((m) => m.action.id)).toEqual(['everything'])
    expect(await registry.actionsFor([])).toEqual([])
    await registry.disable('one')
    expect(await registry.actionsFor(jpg)).toEqual([])
    await expect(registry.action('one', 'count')).rejects.toThrow(/disabled/)
  })

  it('leaves a plugin whose appliesTo throws out of the menu instead of failing it', async () => {
    const registry = new PluginRegistry()
    registry.register(
      fake('broken', {
        actions: [{ id: 'boom', label: 'Boom', appliesTo: () => { throw new Error('bug') }, run: async () => ({ ok: true, message: '' }) }],
      }),
    )
    registry.register(fake('fine'))
    const matches = await registry.actionsFor([{ name: 'a.jpg', isDirectory: false, size: 1 }])
    expect(matches.map((m) => m.plugin.id)).toEqual(['fine', 'fine'])
  })

  it('namespaces settings and secrets per plugin', async () => {
    const backend = memoryBackend()
    const registry = new PluginRegistry(backend)
    registry.register(fake('one'))
    await registry.settingsFor('one').set('server', 'https://x')
    await registry.secretsFor('one').set('token', 't')
    expect(await backend.getSetting('plugin:one:server', null)).toBe('https://x')
    expect(await backend.getSetting('plugin-secret:one:token', null)).toBe('t')
    expect(await registry.settingsFor('two').get('server', 'none')).toBe('none')
    await registry.secretsFor('one').set('token', null)
    expect(await registry.secretsFor('one').get('token')).toBeNull()
  })
})

describe('runAction', () => {
  const tree = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-plugin-'))
    writeFileSync(join(dir, 'a.jpg'), 'x')
    mkdirSync(join(dir, 'album'))
    symlinkSync(join(dir, 'a.jpg'), join(dir, 'link.jpg'))
    return dir
  }

  it('describes the entries from disk and hands the plugin only bare names', async () => {
    const dir = tree()
    const registry = new PluginRegistry()
    registry.register(fake())
    const result = await runAction(registry, 'fake', 'count', { ...host(), dir, names: ['a.jpg', 'album', 'gone.jpg'] })
    expect(result).toEqual({ ok: true, message: `2 entries in ${dir}` })
    expect(await registry.settingsFor('fake').get('last', null)).toEqual(['a.jpg', 'album'])
  })

  it('refuses paths, parents and relative directories', async () => {
    const dir = tree()
    await expect(describeEntries(dir, ['../etc'])).rejects.toThrow(/not a name/)
    await expect(describeEntries(dir, ['a/b'])).rejects.toThrow(/not a name/)
    await expect(describeEntries('relative', ['a.jpg'])).rejects.toThrow(/absolute/)
    // Symlinks are skipped: an action must not follow one out of the directory.
    expect((await describeEntries(dir, ['link.jpg'])).length).toBe(0)
  })

  it('turns a throwing action into a failed result', async () => {
    const dir = tree()
    const registry = new PluginRegistry()
    registry.register(
      fake('thrower', {
        actions: [{ id: 'x', label: 'X', appliesTo: () => true, run: async () => { throw new Error('nope') } }],
      }),
    )
    expect(await runAction(registry, 'thrower', 'x', { ...host(), dir, names: ['a.jpg'] })).toEqual({
      ok: false,
      message: 'nope',
    })
  })
})
