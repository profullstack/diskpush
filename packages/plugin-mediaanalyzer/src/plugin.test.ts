import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginRegistry, memoryBackend, runAction, runTask, silentProgress, type LogLevel } from '@diskpush/plugin-api'
import { FakeMediaAnalyzer, type FakeOptions } from './fake-server.fixture.js'
import { MediaAnalyzerClient, chooseTier } from './client.js'
import { SIGNATURE, batches, createMediaAnalyzerPlugin, loadState, sidecarText } from './index.js'
import { mediaKind } from './media.js'

const servers: FakeMediaAnalyzer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

async function setup(fakeOptions: FakeOptions = {}, env: Record<string, string> = { DISKPUSH_MEDIAANALYZER_KEY: 'ma_key_test' }) {
  const fake = await new FakeMediaAnalyzer(fakeOptions).start()
  servers.push(fake)
  const registry = new PluginRegistry(memoryBackend())
  registry.register(createMediaAnalyzerPlugin({ ffmpeg: null, pollIntervalMs: 5, deviceName: 'test box', loginTimeoutMs: 5000 }))
  await registry.settingsFor('mediaanalyzer').set('server', fake.url)
  const logs: { level: LogLevel; message: string }[] = []
  const host = (overrides: Partial<{ openUrl: (url: string) => Promise<void>; signal: AbortSignal }> = {}) => ({
    progress: { ...silentProgress, log: (level: LogLevel, message: string) => logs.push({ level, message }) },
    openUrl: async () => {},
    signal: new AbortController().signal,
    surface: 'desktop' as const,
    env,
    ...overrides,
  })
  return { fake, registry, logs, host }
}

function photos(count: number, names = (i: number) => `img${String(i).padStart(3, '0')}.jpg`): string {
  const dir = mkdtempSync(join(tmpdir(), 'dp-ma-'))
  for (let i = 0; i < count; i += 1) writeFileSync(join(dir, names(i)), `jpeg bytes ${i}`)
  return dir
}

/** Every file under dir, relative, with its content: the "exact tree" undo must restore. */
function tree(dir: string, skip = (rel: string) => rel.startsWith('.mediaanalyzer')): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const abs = join(at, name)
      const rel = relative(dir, abs)
      if (skip(rel)) continue
      if (statSync(abs).isDirectory()) walk(abs)
      else out[rel] = readFileSync(abs, 'utf8')
    }
  }
  walk(dir)
  return out
}

describe('sign-in', () => {
  it('runs the loopback PKCE flow as the diskpush client and stores the tokens', async () => {
    const { fake, registry, host } = await setup({}, {})
    let opened = ''
    const result = await runTask(registry, 'mediaanalyzer', 'login', host({
      openUrl: async (url) => {
        opened = url
        await fake.approve(url)
      },
    }))
    expect(result).toEqual({ ok: true, message: 'Signed in to MediaAnalyzer as ada@example.com.' })

    const url = new URL(opened)
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('diskpush')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(url.searchParams.get('device_name')).toBe('test box')

    const exchange = fake.tokenRequests[0]!
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', client_id: 'diskpush', device_name: 'test box' })
    expect(exchange.redirect_uri).toBe(url.searchParams.get('redirect_uri'))

    const secrets = registry.secretsFor('mediaanalyzer')
    expect(await secrets.get('refresh_token')).toMatch(/^ma_rt_/)
    expect(await secrets.get('access_token')).toMatch(/^ma_at_/)
  })

  it('rotates refresh tokens: stores each new one at once and never presents a spent one', async () => {
    const { fake, registry, host } = await setup({}, {})
    await runTask(registry, 'mediaanalyzer', 'login', host({ openUrl: (url) => fake.approve(url) }))
    const secrets = registry.secretsFor('mediaanalyzer')
    const client = new MediaAnalyzerClient({ settings: registry.settingsFor('mediaanalyzer'), secrets, env: {} })

    for (let round = 0; round < 3; round += 1) {
      const before = await secrets.get('refresh_token')
      fake.expireAccessTokens()
      await secrets.set('access_expires_at', '0')
      // Two calls at once must share one refresh: two would replay a token.
      await Promise.all([client.me(), client.me()])
      const after = await secrets.get('refresh_token')
      expect(after).not.toBe(before)
      expect(fake.refresh.get(before!)).toBe('spent')
    }
    expect(fake.familyRevoked).toBe(false)
    expect(fake.tokenRequests.filter((request) => request.grant_type === 'refresh_token')).toHaveLength(3)
  })

  it('retries once with a fresh token when the server turns the access token away', async () => {
    const { fake, registry, host } = await setup({}, {})
    await runTask(registry, 'mediaanalyzer', 'login', host({ openUrl: (url) => fake.approve(url) }))
    fake.expireAccessTokens() // expired early, from the server's point of view
    const client = new MediaAnalyzerClient({
      settings: registry.settingsFor('mediaanalyzer'),
      secrets: registry.secretsFor('mediaanalyzer'),
      env: {},
    })
    expect((await client.me()).user.email).toBe('ada@example.com')
  })

  it('signs out by revoking the refresh token', async () => {
    const { fake, registry, host } = await setup({}, {})
    await runTask(registry, 'mediaanalyzer', 'login', host({ openUrl: (url) => fake.approve(url) }))
    const refresh = await registry.secretsFor('mediaanalyzer').get('refresh_token')
    await runTask(registry, 'mediaanalyzer', 'logout', host())
    expect(fake.revoked).toEqual([refresh])
    expect(await registry.secretsFor('mediaanalyzer').get('refresh_token')).toBeNull()
  })

  it('says how to sign in when there is no credential', async () => {
    const { registry, host } = await setup({}, {})
    const dir = photos(1)
    const result = await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: ['img000.jpg'] })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/diskpush mediaanalyzer login/)
  })
})

describe('analyze', () => {
  it('uploads at most 50 files per request and writes a signed sidecar for each', async () => {
    const { fake, registry, host } = await setup()
    const dir = photos(120)
    const names = readdirSync(dir)
    const result = await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names })

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.message).toMatch(/^Described 120 of 120 files/)
    expect(fake.uploadBatches).toEqual([50, 50, 20])
    // The first tier that is online, since none was chosen.
    expect([...fake.scans.values()][0]!.tier).toBe('premium')

    const sidecar = readFileSync(join(dir, 'img007.jpg.description.txt'), 'utf8')
    expect(sidecar).toBe('A picture called img007.jpg.\n\nFolder: Landscapes\nTags: test, photo\n' + SIGNATURE + '\n')
  })

  it('never uploads the same file twice: a second run resumes from the state file', async () => {
    const { fake, registry, host } = await setup()
    const dir = photos(3)
    await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: readdirSync(dir) })
    const state = await loadState(dir)
    expect(Object.keys(state.files)).toHaveLength(3)
    expect(Object.keys(state.files)[0]).toMatch(/^[0-9a-f]{32}$/)

    const again = await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: readdirSync(dir) })
    expect(again.ok).toBe(true)
    expect(fake.uploadBatches).toEqual([3])
  })

  it('stops uploading when credit runs out, keeps what was accepted, and says so', async () => {
    const { fake, registry, host, logs } = await setup({ credit: 60 })
    const dir = photos(120)
    const result = await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: readdirSync(dir) })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Described 50 of 120 files, 70 skipped/)
    expect(result.message).toMatch(/Out of credit/)
    // The first batch went up; the second was refused; the third was never tried.
    expect(fake.uploadBatches).toEqual([50, 50])
    expect(logs.some((log) => log.level === 'error' && /credit/.test(log.message))).toBe(true)
  })

  it('syncs results by finished_after, deduping the inclusive cursor', async () => {
    const { fake, registry, host } = await setup({ pollsBeforeResults: 2 })
    const dir = photos(4, (i) => (i === 3 ? 'broken.jpg' : `ok${i}.jpg`))
    const result = await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: readdirSync(dir) })
    expect(result.message).toMatch(/Described 3 of 4 files, 1 failed/)
    expect(fake.polls).toBeGreaterThanOrEqual(3)
    const state = await loadState(dir)
    expect(state.cursor).toMatch(/^2026-09-24T/)
  })

  it('leaves a sidecar it did not write exactly as it was', async () => {
    const { registry, host, logs } = await setup()
    const dir = photos(1)
    writeFileSync(join(dir, 'img000.jpg.description.txt'), 'my own notes\n')
    await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: ['img000.jpg'] })
    expect(readFileSync(join(dir, 'img000.jpg.description.txt'), 'utf8')).toBe('my own notes\n')
    expect(logs.some((log) => log.level === 'warn' && /not ours/.test(log.message))).toBe(true)
  })

  it('does not pay again for a file that already has our sidecar', async () => {
    const { fake, registry, host } = await setup()
    const dir = photos(2)
    writeFileSync(join(dir, 'img000.jpg.description.txt'), sidecarText({ description: 'x', category: 'Pets', tags: [] }))
    await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: readdirSync(dir) })
    expect(fake.uploadBatches).toEqual([1])
  })

  it('sends a small video whole without ffmpeg, skips a large one, and sends a contact sheet with ffmpeg', async () => {
    const { fake, registry, host, logs } = await setup()
    const dir = photos(1)
    writeFileSync(join(dir, 'clip.mp4'), 'not really a video')
    writeFileSync(join(dir, 'long.mkv'), Buffer.alloc(31 * 1024 * 1024))
    const without = await runAction(registry, 'mediaanalyzer', 'analyze', { ...host(), dir, names: ['clip.mp4', 'long.mkv'] })
    expect(without.message).toMatch(/1 skipped/)
    expect(logs.some((log) => /ffmpeg/.test(log.message))).toBe(true)
    const whole = [...fake.scans.values()].flatMap((scan) => scan.files).find((file) => file.name === 'clip.mp4')!
    expect(whole).toMatchObject({ kind: 'video', partSize: 18 })

    const withFfmpeg = new PluginRegistry(memoryBackend())
    withFfmpeg.register(
      createMediaAnalyzerPlugin({
        pollIntervalMs: 5,
        ffmpeg: { duration: async () => 12.34, contactSheet: async () => Buffer.from('sheet') },
      }),
    )
    await withFfmpeg.settingsFor('mediaanalyzer').set('server', fake.url)
    // A separate folder: the first clip is already analyzed and must not be sent again.
    const other = photos(1)
    writeFileSync(join(other, 'sheet.mp4'), 'not really a video')
    await runAction(withFfmpeg, 'mediaanalyzer', 'analyze', { ...host(), dir: other, names: ['sheet.mp4'] })
    const video = [...fake.scans.values()].flatMap((scan) => scan.files).find((file) => file.name === 'sheet.mp4')!
    expect(video).toMatchObject({ kind: 'video', frames: 9, partSize: 5, bytes: 18 })
  })
})

describe('sort and undo', () => {
  function album() {
    const dir = mkdtempSync(join(tmpdir(), 'dp-ma-sort-'))
    mkdirSync(join(dir, 'trip'))
    mkdirSync(join(dir, 'home'))
    writeFileSync(join(dir, 'trip', 'cat.jpg'), 'trip cat')
    writeFileSync(join(dir, 'home', 'cat.jpg'), 'home cat')
    writeFileSync(join(dir, 'home', 'hill.png'), 'hill')
    writeFileSync(join(dir, 'setup.exe'), 'not media')
    // Already taken in the destination: the sort must go around it.
    mkdirSync(join(dir, 'Landscapes'))
    writeFileSync(join(dir, 'Landscapes', 'hill.png'), 'a different hill')
    return dir
  }

  it('files everything into category folders without overwriting, and undo restores the exact tree', async () => {
    const { registry, host } = await setup()
    const dir = album()
    const before = tree(dir)

    const result = await runAction(registry, 'mediaanalyzer', 'analyze-sort', {
      ...host(),
      dir,
      names: ['home', 'setup.exe', 'trip'],
    })
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/3 moved into folders/)

    const sorted = tree(dir)
    expect(Object.keys(sorted).sort()).toEqual([
      'Landscapes/hill (2).png',
      'Landscapes/hill (2).png.description.txt',
      'Landscapes/hill.png',
      'Pets/cat (2).jpg',
      'Pets/cat (2).jpg.description.txt',
      'Pets/cat.jpg',
      'Pets/cat.jpg.description.txt',
      'setup.exe',
    ])
    expect(sorted['Landscapes/hill.png']).toBe('a different hill')
    expect(sorted['Landscapes/hill (2).png']).toBe('hill')

    // Undo is offered here, because a sort ran here.
    const offered = await registry.actionsFor([{ name: 'setup.exe', isDirectory: false, size: 9 }], dir)
    expect(offered.map((match) => match.action.id)).toContain('undo-sort')

    const undone = await runAction(registry, 'mediaanalyzer', 'undo-sort', { ...host(), dir, names: ['setup.exe'] })
    expect(undone).toMatchObject({ ok: true, message: 'Put back 6 files.' })

    const restored = tree(dir, (rel) => rel.startsWith('.mediaanalyzer') || rel.endsWith('.description.txt'))
    expect(restored).toEqual(before)
    // The descriptions came back beside the files they describe.
    expect(readFileSync(join(dir, 'trip', 'cat.jpg.description.txt'), 'utf8')).toContain(SIGNATURE)
    // Pets/ was made by the sort and is empty again, so it is gone; Landscapes/ was the user's.
    expect(readdirSync(dir).sort()).toEqual(['.mediaanalyzer', 'Landscapes', 'home', 'setup.exe', 'trip'])
  })

  it('undo skips a file the user has since put something in place of', async () => {
    const { registry, host } = await setup()
    const dir = album()
    await runAction(registry, 'mediaanalyzer', 'analyze-sort', { ...host(), dir, names: ['home', 'setup.exe', 'trip'] })
    writeFileSync(join(dir, 'home', 'cat.jpg'), 'a new cat')
    const undone = await runAction(registry, 'mediaanalyzer', 'undo-sort', { ...host(), dir, names: ['setup.exe'] })
    expect(undone.ok).toBe(false)
    expect(readFileSync(join(dir, 'home', 'cat.jpg'), 'utf8')).toBe('a new cat')
    expect(readFileSync(join(dir, 'Pets', 'cat.jpg'), 'utf8')).toBe('home cat')
  })
})

describe('pieces', () => {
  it('knows every family the server reads: pandoc, LibreOffice, PDF, ffmpeg, ImageMagick, RAW', () => {
    const cases: Record<string, string | null> = {
      'a.pdf': 'document', 'a.DOCX': 'document', 'a.xlsx': 'document', 'a.pptx': 'document', 'a.odt': 'document', 'a.epub': 'document',
      'a.md': 'document', 'a.csv': 'document', 'a.mp3': 'audio', 'a.flac': 'audio', 'a.m4a': 'audio', 'a.mkv': 'video', 'a.mov': 'video',
      'a.jpg': 'photo', 'a.psd': 'photo', 'a.CR2': 'photo', 'a.nef': 'photo', 'a.eps': 'photo', 'a.heic': 'photo', 'a.exe': null, 'noext': null,
    }
    for (const [name, kind] of Object.entries(cases)) expect(mediaKind(name), name).toBe(kind)
  })

  it('batches by count and by bytes', () => {
    const item = (bytes: number) => ({ meta: { bytes }, blob: new Blob([new Uint8Array(bytes)]) })
    expect(batches(Array.from({ length: 101 }, () => item(1))).map((batch) => batch.length)).toEqual([50, 50, 1])
    expect(batches([item(40e6), item(30e6), item(1)]).map((batch) => batch.length)).toEqual([1, 2])
  })

  it('chooses the first online tier, else byok with the first provider', () => {
    const me = {
      user: { email: '' },
      balance_usd: 0,
      available_usd: 0,
      categories: [],
      tiers: [{ id: 'standard', name: '', usd_per_file: 0, model: '', online: false }],
      providers: [{ id: 'pk_1', label: '', kind: '', model: '' }],
    }
    expect(chooseTier(me, { tier: '', providerId: '' })).toEqual({ tier: 'byok', provider_key_id: 'pk_1' })
    expect(chooseTier({ ...me, tiers: [{ ...me.tiers[0]!, online: true }] }, { tier: '', providerId: '' })).toEqual({ tier: 'standard' })
    expect(chooseTier(me, { tier: 'premium', providerId: '' })).toEqual({ tier: 'premium' })
    expect(() => chooseTier({ ...me, providers: [] }, { tier: '', providerId: '' })).toThrow(/No MediaAnalyzer tier/)
  })
})
