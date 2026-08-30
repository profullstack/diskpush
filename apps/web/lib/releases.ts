/**
 * Normalised release metadata.
 *
 * GitHub's response shape is kept out of the rest of the site: pages read this
 * type, so a change at GitHub is one file's problem. No database is introduced
 * for what is a cacheable read of a public endpoint.
 */
export type ReleaseInfo = {
  version: string
  publishedAt: string
  notesUrl: string
  assets: {
    linuxAppImage: string | null
    linuxDeb: string | null
    macDmg: string | null
    windowsExe: string | null
  }
}

type GithubAsset = { name: string; browser_download_url: string }
type GithubRelease = {
  tag_name: string
  published_at: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

const ENDPOINT = 'https://api.github.com/repos/profullstack/diskpush/releases/latest'

function pick(assets: readonly GithubAsset[], test: RegExp): string | null {
  return assets.find((asset) => test.test(asset.name))?.browser_download_url ?? null
}

/**
 * The last release we successfully read, kept so a refused fetch degrades to
 * slightly stale instead of to nothing.
 *
 * Unauthenticated GitHub allows exactly 60 requests an hour per IP. This is a
 * shared host, so that budget is not ours alone, and a burst of crawler traffic
 * spends it: after the site was audited by fifteen engines plus a recursive
 * link checker, every call was refused and `/download` had no release to show
 * — while the artifacts were published and downloadable the whole time.
 *
 * A version a few minutes old is a far better answer than no version, so once
 * we have read one we never go back to showing nothing.
 */
let lastKnownGood: ReleaseInfo | null = null

/**
 * A token lifts the ceiling from 60 requests an hour to 5,000. Optional on
 * purpose: the site has to work without one, which is what the cache above is
 * for. Set GITHUB_TOKEN on the service to stop relying on it.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export async function latestRelease(): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(ENDPOINT, {
      headers: githubHeaders(),
      next: { revalidate: 60 },
    })
    // 404 means no tagged release yet — a normal pre-launch state. 403 with a
    // spent budget means we are rate limited, which is not a fact about the
    // project and must not be shown as one. Both fall back to what we last saw.
    if (!response.ok) return lastKnownGood

    const release = (await response.json()) as GithubRelease
    if (release.draft) return lastKnownGood

    const info: ReleaseInfo = {
      version: release.tag_name.replace(/^v/, ''),
      publishedAt: release.published_at,
      notesUrl: release.html_url,
      assets: {
        linuxAppImage: pick(release.assets, /\.AppImage$/i),
        linuxDeb: pick(release.assets, /\.deb$/i),
        macDmg: pick(release.assets, /\.dmg$/i),
        windowsExe: pick(release.assets, /\.(exe|msi)$/i),
      },
    }
    lastKnownGood = info
    return info
  } catch {
    return lastKnownGood
  }
}
