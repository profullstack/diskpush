export const SITE = {
  name: 'DiskPush',
  tagline: 'Push files fast. Sync only what changed.',
  url: 'https://diskpush.com',
  repo: 'https://github.com/profullstack/diskpush',
  releases: 'https://github.com/profullstack/diskpush/releases',
  description:
    'Browse servers like FileZilla and transfer with rsync. DiskPush provides resumable incremental sync, direct server-to-server transfers, desktop and CLI workflows.',
} as const

export const NAV = [
  { href: '/#features', label: 'Features' },
  { href: '/docs', label: 'Docs' },
  { href: '/docs/cli', label: 'CLI' },
  { href: '/download', label: 'Download' },
  { href: SITE.repo, label: 'GitHub', external: true },
] as const
