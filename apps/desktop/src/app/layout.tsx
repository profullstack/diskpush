import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Geist } from 'next/font/google'
import './globals.css'
import { cn } from "@/lib/utils";

/**
 * Self-hosted at build time by next/font, which matters here: the renderer
 * runs under `font-src 'self' data:`, so a stylesheet from Google would be
 * blocked and the app would silently fall back to a system face.
 */
const geist = Geist({subsets:['latin'],variable:'--font-sans'})

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
    <html lang="en" className={cn(mono.variable, "font-sans", geist.variable)}>
      <body className="h-full font-[family-name:var(--font-sans)]">{children}</body>
    </html>
  )
}
