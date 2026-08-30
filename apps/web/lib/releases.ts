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

export async function latestRelease(): Promise<ReleaseInfo | null> {
  try {
    const response = await fetch(ENDPOINT, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 60 },
    })
    // A repository with no tagged release yet answers 404. That is a normal
    // state before launch, not an error worth surfacing to a visitor.
    if (!response.ok) return null

    const release = (await response.json()) as GithubRelease
    if (release.draft) return null

    return {
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
  } catch {
    return null
  }
}
