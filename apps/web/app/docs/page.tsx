import type { Metadata } from 'next'
import Link from 'next/link'
import { listDocs } from '@/lib/docs'

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'How DiskPush works: defaults, the CLI, rsync options, direct server-to-server transfers, and the security model.',
  alternates: { canonical: '/docs' },
}

export default async function DocsIndex() {
  const docs = await listDocs()
  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
      <p className="mt-3 text-muted">
        These pages are rendered from the repository&rsquo;s own <code className="font-mono text-sm">docs/</code>{' '}
        directory, so they cannot drift from the product.
      </p>
      <ul className="mt-10 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
        {docs.map((doc) => (
          <li key={doc.slug} className="bg-ink">
            <Link href={`/docs/${doc.slug}`} className="block p-5 transition-colors hover:bg-surface">
              <span className="font-medium">{doc.title}</span>
              {doc.description ? <span className="mt-1 block text-sm text-muted">{doc.description}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
