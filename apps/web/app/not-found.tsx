import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-24 text-center">
      <h1 className="text-3xl font-bold tracking-tight">Not found</h1>
      <p className="mt-3 text-muted">That page does not exist.</p>
      <div className="mt-8 flex justify-center gap-3">
        <Link href="/" className="rounded-md bg-accent px-4 py-2 font-medium text-ink">Home</Link>
        <Link href="/docs" className="rounded-md border border-line px-4 py-2 font-medium hover:bg-surface">Docs</Link>
      </div>
    </div>
  )
}
