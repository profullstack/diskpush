import type { Metadata } from 'next'
import { Footer, Header } from '@/components/chrome'
import { SITE } from '@/lib/site'
import './globals.css'
import Script from "next/script";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: 'DiskPush — Fast rsync Desktop App & CLI',
    template: '%s — DiskPush',
  },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [
    'rsync GUI',
    'rsync desktop app',
    'rsync client',
    'FileZilla alternative',
    'SFTP rsync GUI',
    'server to server file transfer',
    'server to server rsync',
    'resumable file transfer SSH',
    'Linux rsync GUI',
    'rsync two pane file manager',
  ],
  alternates: { canonical: '/' },
  manifest: '/manifest.json',
  // The generated set from the repository root, wired through Next's metadata
  // API rather than as raw <link> tags so every route inherits it.
  icons: {
    icon: [
      { url: '/favicon.png', type: 'image/png' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: ['/icons/favicon.ico'],
    apple: [180, 152, 144, 120, 114, 76, 72, 60, 57].map((size) => ({
      url: `/icons/apple-touch-icon-${size}x${size}.png`,
      sizes: `${size}x${size}`,
    })),
  },
  appleWebApp: { capable: true, title: 'DiskPush', statusBarStyle: 'black-translucent' },
  other: {
    'mobile-web-app-capable': 'yes',
    'msapplication-TileColor': '#0b62fd',
    'msapplication-config': '/browserconfig.xml',
    'msapplication-TileImage': '/icons/apple-touch-icon-144x144.png',
  },
  openGraph: {
    type: 'website',
    url: SITE.url,
    siteName: SITE.name,
    title: 'DiskPush — Fast rsync Desktop App & CLI',
    description: SITE.description,
    images: [{ url: '/social-card.png', width: 1200, height: 630, alt: 'DiskPush — push files fast, sync only what changed.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DiskPush — Fast rsync Desktop App & CLI',
    description: SITE.description,
    images: ['/social-card.png'],
  },
}

/**
 * Matches the palette's dark-by-default, light-on-request strategy, so browser
 * chrome does not disagree with the page behind it.
 */
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#070c16' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
              <Script data-site="4f356371-83a0-4cb2-b570-75b961e6ddcb" src="https://crawlproof.com/stats.js" strategy="afterInteractive" />
      </body>
    </html>
  )
}
