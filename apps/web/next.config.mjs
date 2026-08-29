/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The docs pages read Markdown from the repository at build time, so the
  // site and the repo can never disagree about what DiskPush does.
  outputFileTracingIncludes: {
    '/docs/[slug]': ['../../docs/**/*.md'],
    '/docs': ['../../docs/**/*.md'],
    // The installer is served from the repository's own copy.
    '/install.sh': ['../../scripts/install.sh'],
  },
}

export default nextConfig
