/** @type {import('next').NextConfig} */

// Response headers the site was serving none of.
//
// The CSP is deliberately not `default-src 'self'` alone: Next inlines its
// hydration payload in a <script>, and the app's styles arrive inline too, so a
// policy without 'unsafe-inline' in those two places blanks the page. Scripts
// are otherwise same-origin only, which is the part that actually limits an
// injection, and `object-src 'none'` plus `frame-ancestors 'none'` close the
// two classic bypasses. The one third-party script origin besides the WebMCP
// embed is crawlproof.com, our own analytics and ad server.
const csp = [
  "default-src 'self'",
  // crawlproof.com serves stats.js (analytics) and ad.js. Without it here the
  // browser refuses both tags in the layout and the site records no traffic.
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://crawlproof.com",
  "style-src 'self' 'unsafe-inline'",
  // Ad creatives render in a srcdoc frame, which inherits this policy, and
  // their images come from whatever host the advertiser used. Images cannot
  // run script, so any https origin is allowed.
  "img-src 'self' data: https:",
  "media-src 'self' https://crawlproof.com https://supabase.crawlproof.com",
  "font-src 'self' data:",
  // The download page reads release metadata from the GitHub API; stats.js
  // and ad.js post page views and ad requests back to crawlproof.com.
  "connect-src 'self' https://api.github.com https://crawlproof.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

const securityHeaders = [
  // Two years, subdomains included. No preload: the list's own operators now
  // discourage it, and it is a one-way door.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // frame-ancestors above is the real control; this is the legacy fallback.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig = {
  reactStrictMode: true,
  // The dev2 image runs .next/standalone under Bun (see .nixpacks/Dockerfile).
  // The tracing root is the repository root, so the server lands at
  // .next/standalone/apps/web/server.js and the docs/ and scripts/ includes
  // below land at the same ../../ path the pages read them from.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // The docs pages read Markdown from the repository at build time, so the
  // site and the repo can never disagree about what DiskPush does.
  outputFileTracingIncludes: {
    '/docs/[slug]': ['../../docs/**/*.md'],
    '/docs': ['../../docs/**/*.md'],
    // The installer is served from the repository's own copy.
    '/install.sh': ['../../scripts/install.sh'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
