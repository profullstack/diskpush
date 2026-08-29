import Link from 'next/link'
import { NAV, SITE } from '@/lib/site'

/** Server components: the navigation needs no JavaScript to work. */
export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-2.5">
        <Link href="/" className="flex items-center" aria-label={SITE.name}>
          <Logo />
        </Link>
        <nav className="ml-auto flex items-center gap-1 text-sm">
          {NAV.filter((item) => item.label !== 'Download').map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="hidden rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-surface hover:text-text sm:block"
              {...('external' in item && item.external ? { rel: 'noreferrer', target: '_blank' } : {})}
            >
              {item.label}
            </Link>
          ))}
          <Link
            href="/download"
            className="ml-2 rounded-md bg-accent-strong px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90"
          >
            Download
          </Link>
        </nav>
      </div>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-8 text-sm text-muted">
        <span className="font-medium text-text">{SITE.name}</span>
        <Link href="/docs" className="hover:text-text">Docs</Link>
        <a href={SITE.repo} className="hover:text-text" rel="noreferrer" target="_blank">GitHub</a>
        <a href={SITE.releases} className="hover:text-text" rel="noreferrer" target="_blank">Releases</a>
        <Link href="/security" className="hover:text-text">Security</Link>
        <Link href="/privacy" className="hover:text-text">Privacy</Link>
        <span className="ml-auto">MIT licensed</span>
      </div>
    </footer>
  )
}

/**
 * The wordmark, in both variants. Which one shows is decided by CSS rather
 * than JavaScript, so it is correct in the first paint and needs no client
 * component.
 *
 * Not Tailwind's `dark:`, deliberately: that matches an explicit dark
 * preference, while this palette treats dark as the default and light as the
 * override. A visitor with no preference set would otherwise get a dark page
 * and the dark-text logo on it.
 */
function Logo() {
  return (
    <>
      <img
        src="/logo.dark.png"
        alt="DiskPush"
        width={2172}
        height={724}
        className="logo-dark w-60 h-auto"
      />
      <img src="/logo.png" alt="DiskPush" width={2172} height={724} className="logo-light w-60 h-auto" />
    </>
  )
}

export function Code({ children, label }: { children: string; label?: string }) {
  return (
    // `min-w-0` matters: without it this block is a grid child with
    // min-width:auto, and the pre below widens the page rather than scrolling.
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      {label ? (
        <div className="border-b border-line px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted">
          {label}
        </div>
      ) : null}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  )
}
