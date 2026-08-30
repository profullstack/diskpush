import type { Metadata } from 'next'
import { IBM_Plex_Mono, Geist } from 'next/font/google'
import './globals.css'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Self-hosted at build time by next/font, which matters here: the renderer
 * runs under `font-src 'self' data:`, so a stylesheet from Google would be
 * blocked and the app would silently fall back to a system face.
 */
const geist = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'DiskPush',
  description: 'Push files fast. Sync only what changed.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(mono.variable, geist.variable, 'font-sans')}>
      {/*
        No third-party analytics tag here. One used to load stats.js from a
        remote origin, which the shell's own CSP (`script-src 'self'`) blocks
        outright -- so it never reported anything, and all it actually did was
        make a desktop file transfer tool look like it phones home.
      */}
      <body className="h-full font-[family-name:var(--font-sans)] antialiased">
        <TooltipProvider delay={350}>{children}</TooltipProvider>
      </body>
    </html>
  )
}
