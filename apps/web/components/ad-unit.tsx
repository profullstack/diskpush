'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const AD_SLOT = '8d21a830-acfe-40ba-9d0d-0078d66ca479'

/**
 * One CrawlProof unit at the top of the content, never by the footer: the
 * low-profile text_link line (40px, fluid, its own "Sponsored" mark). The
 * homepage carries no ad.
 */
export function AdUnit() {
  const pathname = usePathname() ?? '/'
  if (pathname === '/') return null
  // Keyed by path: ad.js latches a filled unit, so each navigation gets a fresh one.
  return <Unit key={pathname} />
}

function Unit() {
  useEffect(() => {
    // ad.js scans once at load; a unit mounted by client navigation asks again.
    ;(window as unknown as { crawlproofAds?: { scan?: () => void } }).crawlproofAds?.scan?.()
  }, [])
  return (
    <div className="mx-auto max-w-6xl px-5 pt-2">
      <div data-cp-ad="" data-slot={AD_SLOT} data-format="text_link" />
    </div>
  )
}
