import { describe, expect, it } from 'vitest'
import {
  IPC,
  LocalDirectorySchema,
  PluginActionRequestSchema,
  PluginSelectionSchema,
  PluginSettingsSetSchema,
  PluginTaskRequestSchema,
} from './contract.js'

/**
 * The plugin channels, as a compromised renderer would probe them. Plugin
 * code runs in the main process with the user's privileges, so what the
 * renderer can name here is exactly what it could make a plugin touch.
 */

const JOB = '6f1c2f6e-3b1a-4c1e-9a55-0d2b7b0c8a11'
const request = (over: Record<string, unknown> = {}) => ({
  jobId: JOB,
  pluginId: 'mediaanalyzer',
  actionId: 'analyze-sort',
  dir: '/home/me/photos',
  names: ['cat.jpg', '2024'],
  ...over,
})

describe('plugin action requests', () => {
  it('accept a local directory and bare entry names', () => {
    expect(PluginActionRequestSchema.parse(request())).toEqual(request())
  })

  it('reject a name that is really a path', () => {
    for (const name of ['../etc/passwd', 'a/b', '..', '.', 'a\\b', 'x\0y', ' padded', '']) {
      expect(PluginActionRequestSchema.safeParse(request({ names: [name] })).success, JSON.stringify(name)).toBe(false)
    }
  })

  it('reject a relative or remote directory', () => {
    for (const dir of ['photos', './photos', 'prod:/srv/photos', 'deploy@host:/srv', '', '/tmp/\0x']) {
      expect(PluginActionRequestSchema.safeParse(request({ dir })).success, dir).toBe(false)
    }
    expect(LocalDirectorySchema.safeParse('C:\\Users\\me').success).toBe(true)
    expect(LocalDirectorySchema.safeParse('~/photos').success).toBe(true)
  })

  it('reject an empty selection, a made-up id shape, and a job id that is not a uuid', () => {
    expect(PluginActionRequestSchema.safeParse(request({ names: [] })).success).toBe(false)
    expect(PluginActionRequestSchema.safeParse(request({ pluginId: '../x' })).success).toBe(false)
    expect(PluginActionRequestSchema.safeParse(request({ actionId: 'Run Anything' })).success).toBe(false)
    expect(PluginActionRequestSchema.safeParse(request({ jobId: 'job-1' })).success).toBe(false)
    expect(PluginTaskRequestSchema.safeParse({ jobId: JOB, pluginId: 'mediaanalyzer', taskId: 'login' }).success).toBe(true)
  })

  it('drops fields the contract does not have: no command line, no env, no path list', () => {
    const parsed = PluginActionRequestSchema.parse(request({ command: 'rm -rf ~', env: { X: '1' }, paths: ['/etc'] }))
    expect(Object.keys(parsed).sort()).toEqual(['actionId', 'dir', 'jobId', 'names', 'pluginId'])
    expect(Object.keys(PluginSelectionSchema.parse({ dir: '/a', names: ['b'], extra: 1 })).sort()).toEqual(['dir', 'names'])
  })
})

describe('plugin settings', () => {
  it('take plain values under setting-shaped keys only', () => {
    expect(PluginSettingsSetSchema.safeParse({ pluginId: 'mediaanalyzer', values: { tier: 'premium', api_key: null } }).success).toBe(true)
    expect(PluginSettingsSetSchema.safeParse({ pluginId: 'mediaanalyzer', values: { '../x': 'y' } }).success).toBe(false)
    expect(PluginSettingsSetSchema.safeParse({ pluginId: 'mediaanalyzer', values: { tier: { nested: true } } }).success).toBe(false)
    expect(PluginSettingsSetSchema.safeParse({ pluginId: 'mediaanalyzer', values: { tier: 'x'.repeat(5000) } }).success).toBe(false)
  })
})

describe('channels', () => {
  it('are the plugins: namespace the preload exposes by name', () => {
    expect(IPC.pluginsList).toBe('plugins:list')
    expect(IPC.pluginsRunAction).toBe('plugins:run-action')
    expect(IPC.pluginsCancel).toBe('plugins:cancel')
    expect(IPC.pluginsGetSettings).toBe('plugins:get-settings')
    expect(IPC.pluginsSetSettings).toBe('plugins:set-settings')
    expect(IPC.eventPlugin).toBe('plugins:progress')
  })
})
