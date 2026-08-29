import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { listDocs, readDoc } from '@/lib/docs'

type Params = { params: Promise<{ slug: string }> }

/** Pre-rendered at build time: the docs are static files, so the pages are too. */
export async function generateStaticParams() {
  const docs = await listDocs()
  return docs.map((doc) => ({ slug: doc.slug }))
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const doc = await readDoc(slug)
  if (!doc) return { title: 'Not found' }
  const meta = (await listDocs()).find((entry) => entry.slug === slug)
  return {
    title: doc.title,
    description: meta?.description || `${doc.title} — DiskPush documentation.`,
    alternates: { canonical: `/docs/${slug}` },
  }
}

export default async function DocPage({ params }: Params) {
  const { slug } = await params
  const doc = await readDoc(slug)
  if (!doc) notFound()

  const docs = await listDocs()

  return (
    <div className="mx-auto flex max-w-6xl gap-10 px-5 py-12">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-20">
          <Link href="/docs" className="text-xs font-medium uppercase tracking-wider text-muted hover:text-text">
            Documentation
          </Link>
          <nav className="mt-3 space-y-0.5 text-sm">
            {docs.map((entry) => (
              <Link
                key={entry.slug}
                href={`/docs/${entry.slug}`}
                aria-current={entry.slug === slug ? 'page' : undefined}
                className={
                  entry.slug === slug
                    ? 'block rounded-md bg-surface px-2.5 py-1.5 font-medium text-accent'
                    : 'block rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-surface hover:text-text'
                }
              >
                {entry.title}
              </Link>
            ))}
          </nav>
        </div>
      </aside>

      <article className="prose-docs min-w-0 flex-1">
        <div dangerouslySetInnerHTML={{ __html: doc.html }} />
      </article>
    </div>
  )
}
