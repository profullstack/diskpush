import type { Metadata } from 'next'
import { Footer, Header } from '@/components/chrome'
import { SITE } from '@/lib/site'
import './globals.css'

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
  openGraph: {
    type: 'website',
    url: SITE.url,
    siteName: SITE.name,
    title: 'DiskPush — Fast rsync Desktop App & CLI',
    description: SITE.description,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DiskPush — Fast rsync Desktop App & CLI',
    description: SITE.description,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
