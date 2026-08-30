import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { MetadataRoute } from 'next'
import { listDocs } from '@/lib/docs'
import { SITE } from '@/lib/site'

const run = promisify(execFile)

/**
 * Every URL used to carry `new Date()`, so all eighteen shared one build
 * timestamp. A lastmod that is identical site-wide and changes on every deploy
 * says nothing about what actually changed, so crawlers discount it — which is
 * worse than sending none, because it costs a field and buys nothing.
 *
 * The date has to come from git, not from the filesystem. An earlier version of
 * this read mtimes, which is correct on a working tree and useless in CI: a
 * clone stamps every file with the checkout time, so in production all eighteen
 * collapsed back to a single date and the fix silently did nothing. mtime is
 * kept only as a fallback for a build with no git history, where it is no worse
 * than the build clock it replaces.
 */
const ROOT = join(process.cwd(), '..', '..')
const buildTime = new Date()

/** When git last changed this path, or null if git cannot say. */
async function committed(path: string): Promise<Date | null> {
  try {
    const { stdout } = await run('git', ['log', '-1', '--format=%cI', '--', path], { cwd: ROOT })
    const iso = stdout.trim()
    if (!iso) return null
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? null : date
  } catch {
    // No git, no history, or a shallow clone that does not reach this commit.
    return null
  }
}

async function touched(path: string): Promise<Date | null> {
  try {
    return (await stat(join(ROOT, path))).mtime
  } catch {
    return null
  }
}

/** The newest real date across the sources a page is built from. */
async function modified(...paths: string[]): Promise<Date> {
  const dates = await Promise.all(
    paths.map(async (path) => (await committed(path)) ?? (await touched(path))),
  )
  const known = dates.filter((date): date is Date => date !== null)
  if (known.length === 0) return buildTime
  return new Date(Math.max(...known.map((date) => date.getTime())))
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await listDocs()
  const web = 'apps/web'

  const [home, download, docsIndex, security, privacy] = await Promise.all([
    modified(`${web}/app/page.tsx`, `${web}/app/layout.tsx`),
    modified(`${web}/app/download/page.tsx`, `${web}/lib/releases.ts`),
    modified(`${web}/app/docs/page.tsx`),
    modified(`${web}/app/security/page.tsx`, 'docs/security.md'),
    modified(`${web}/app/privacy/page.tsx`),
  ])

  const docEntries = await Promise.all(
    docs.map(async (doc) => ({
      url: `${SITE.url}/docs/${doc.slug}`,
      lastModified: await modified(`docs/${doc.slug}.md`),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  )

  return [
    { url: SITE.url, lastModified: home, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE.url}/download`, lastModified: download, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE.url}/docs`, lastModified: docsIndex, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${SITE.url}/security`, lastModified: security, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE.url}/privacy`, lastModified: privacy, changeFrequency: 'yearly', priority: 0.3 },
    ...docEntries,
  ]
}
