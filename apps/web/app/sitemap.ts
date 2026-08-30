import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MetadataRoute } from 'next'
import { listDocs } from '@/lib/docs'
import { SITE } from '@/lib/site'

/**
 * Every URL used to carry `new Date()`, so all eighteen shared one build
 * timestamp. A lastmod that changes on every deploy and is identical across the
 * site says nothing about what actually changed, and crawlers discount it —
 * which is worse than sending none, because it costs a field and buys nothing.
 *
 * The real date is on disk. Doc pages are rendered from the repository's own
 * `docs/*.md`, so that file's mtime *is* when the page last changed; the rest
 * are their own source files. Falls back to the build time only when a stat
 * fails, which should not happen but must not break the sitemap if it does.
 */
const ROOT = join(process.cwd(), '..', '..')
const buildTime = new Date()

async function modified(...relative: string[]): Promise<Date> {
  const times = await Promise.all(
    relative.map(async (path) => {
      try {
        return (await stat(join(ROOT, path))).mtime
      } catch {
        return null
      }
    }),
  )
  const known = times.filter((time): time is Date => time !== null)
  if (known.length === 0) return buildTime
  // The newest of the sources a page is built from.
  return new Date(Math.max(...known.map((time) => time.getTime())))
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await listDocs()
  const web = 'apps/web'

  const [home, download, docsIndex, security, privacy] = await Promise.all([
    modified(`${web}/app/page.tsx`, `${web}/app/layout.tsx`),
    modified(`${web}/app/download/page.tsx`),
    modified(`${web}/app/docs/page.tsx`),
    modified(`${web}/app/security/page.tsx`),
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
