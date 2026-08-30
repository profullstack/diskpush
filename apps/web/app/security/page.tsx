import type { Metadata } from 'next'
import Link from 'next/link'
import { DocsCopyButtons } from '@/components/docs-copy'
import { readDoc } from '@/lib/docs'

export const metadata: Metadata = {
  title: 'Security',
  description: 'How DiskPush handles shell execution, remote arguments, host keys, credentials and destructive operations.',
  alternates: { canonical: '/security' },
}

export default async function SecurityPage() {
  const doc = await readDoc('security')
  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <article className="prose-docs" dangerouslySetInnerHTML={{ __html: doc?.html ?? '' }} />
      <DocsCopyButtons />
      <p className="mt-10 text-sm text-muted">
        This page is the repository&rsquo;s{' '}
        <Link href="/docs/security" className="text-accent hover:underline">
          docs/security.md
        </Link>
        , rendered.
      </p>
    </div>
  )
}
