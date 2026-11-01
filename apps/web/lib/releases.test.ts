// Unauthenticated GitHub allows exactly 60 requests an hour per IP, and this is
// a shared host, so that budget is not ours alone. Rate limiting must not make
// a published release disappear; a cold process can verify this build's
// version by checking the public release assets directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import webPackage from '../package.json'

const ENDPOINT = 'https://api.github.com/repos/profullstack/diskpush/releases/latest'

const release = (tag: string) => ({
  tag_name: tag,
  name: `DiskPush ${tag}`,
  html_url: `https://github.com/profullstack/diskpush/releases/tag/${tag}`,
  published_at: '2026-08-30T03:41:00Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: `DiskPush-${tag.slice(1)}-linux-x86_64.AppImage`, browser_download_url: 'https://example.test/a' },
    { name: `DiskPush-${tag.slice(1)}-linux-amd64.deb`, browser_download_url: 'https://example.test/d' },
  ],
})

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response
const refused = () => ({ ok: false, status: 403 }) as unknown as Response

/** A fresh module per test, because the fallback is deliberately module state. */
async function load() {
  vi.resetModules()
  return import('./releases.js')
}

describe('latestRelease', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_TOKEN', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reads the current release and maps its assets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(release('v0.1.9'))))
    const { latestRelease } = await load()

    const info = await latestRelease()
    expect(info?.version).toBe('0.1.9')
    expect(info?.assets.linuxAppImage).toBe('https://example.test/a')
    expect(info?.assets.linuxDeb).toBe('https://example.test/d')
    // Nothing in this release matches those, and a wrong URL is worse than none.
    expect(info?.assets.macDmg).toBeNull()
    expect(info?.assets.windowsExe).toBeNull()
  })

  it('keeps serving the last release it read when GitHub refuses', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(release('v0.1.9')))
      .mockResolvedValue(refused())
    vi.stubGlobal('fetch', fetcher)
    const { latestRelease } = await load()

    expect((await latestRelease())?.version).toBe('0.1.9')
    // This is the regression: it used to be null, and the page showed nothing.
    expect((await latestRelease())?.version).toBe('0.1.9')
    expect((await latestRelease())?.version).toBe('0.1.9')
  })

  it('finds this build’s release through its public assets when GitHub API quota is spent', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === ENDPOINT) return refused()
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'last-modified': 'Sun, 01 Nov 2026 11:10:02 GMT' },
        })
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetcher)
    const { latestRelease } = await load()

    const info = await latestRelease()
    expect(info).toMatchObject({
      version: webPackage.version,
      publishedAt: '2026-11-01T11:10:02.000Z',
      notesUrl: `https://github.com/profullstack/diskpush/releases/tag/v${webPackage.version}`,
      assets: {
        linuxAppImage: `https://github.com/profullstack/diskpush/releases/download/v${webPackage.version}/DiskPush-${webPackage.version}-linux-x86_64.AppImage`,
        linuxDeb: `https://github.com/profullstack/diskpush/releases/download/v${webPackage.version}/DiskPush-${webPackage.version}-linux-amd64.deb`,
        macDmg: null,
        windowsExe: null,
      },
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('survives the fetch throwing outright, not just answering badly', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(release('v0.1.9')))
      .mockRejectedValue(new Error('ECONNRESET'))
    vi.stubGlobal('fetch', fetcher)
    const { latestRelease } = await load()

    expect((await latestRelease())?.version).toBe('0.1.9')
    expect((await latestRelease())?.version).toBe('0.1.9')
  })

  it('still answers null before this build has a published release asset', async () => {
    // A repository with no tagged release yet is a real pre-launch state, and
    // the page has a legitimate empty rendering for it. A 403 on the REST API
    // is followed by HEAD checks for the versioned assets; they are not there.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ENDPOINT ? refused() : new Response(null, { status: 404 }),
      ),
    )
    const { latestRelease } = await load()
    expect(await latestRelease()).toBeNull()
  })

  it('sends no Authorization header without a token, and one with', async () => {
    // Parameters spelled out so the call log is typed; an inferred `async () =>`
    // gives vi.fn an empty tuple and every mock.calls index is a type error.
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ok(release('v0.1.9')))
    vi.stubGlobal('fetch', fetcher)

    const anon = await load()
    await anon.latestRelease()
    expect(fetcher.mock.calls[0][0]).toBe(ENDPOINT)
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')

    vi.stubEnv('GITHUB_TOKEN', 'ghp_example')
    fetcher.mockClear()
    const authed = await load()
    await authed.latestRelease()
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer ghp_example',
    })
  })
})
