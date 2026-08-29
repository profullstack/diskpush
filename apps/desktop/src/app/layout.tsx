import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'DiskPush',
  description: 'Push files fast. Sync only what changed.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  )
}
