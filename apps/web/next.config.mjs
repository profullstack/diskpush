/** @type {import('next').NextConfig} */

// Response headers the site was serving none of.
//
// The CSP is deliberately not `default-src 'self'` alone: Next inlines its
// hydration payload in a <script>, and the app's styles arrive inline too, so a
// policy without 'unsafe-inline' in those two places blanks the page. Scripts
// are otherwise same-origin only, which is the part that actually limits an
// injection, and `object-src 'none'` plus `frame-ancestors 'none'` close the
// two classic bypasses.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // The download page reads release metadata from the GitHub API.
  "connect-src 'self' https://api.github.com",
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
