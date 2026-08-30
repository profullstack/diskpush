// diskpush.com/download showed no release at all while v0.1.9 was published,
// built and downloadable.
//
// Unauthenticated GitHub allows exactly 60 requests an hour per IP, and this is
// a shared host, so that budget is not ours alone. Lowering the release cache
// from an hour to a minute made 60/hour the ceiling rather than a limit we
// never approached, and a burst of crawler traffic — fifteen audit engines plus
// a recursive link checker — spent it. Every call came back 403, latestRelease
// returned null, and the page rendered as though the project had never shipped.
//
// Rate limiting is a fact about our IP, not about the project, and must never
// be presented as one. Once a release has been read, the page shows it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('still answers null before it has ever seen a release', async () => {
    // A repository with no tagged release yet is a real pre-launch state, and
    // the page has a legitimate empty rendering for it.
    vi.stubGlobal('fetch', vi.fn(async () => refused()))
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
