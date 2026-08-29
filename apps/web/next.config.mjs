/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The docs pages read Markdown from the repository at build time, so the
  // site and the repo can never disagree about what DiskPush does.
  outputFileTracingIncludes: {
    '/docs/[slug]': ['../../docs/**/*.md'],
    '/docs': ['../../docs/**/*.md'],
  },
}

export default nextConfig
