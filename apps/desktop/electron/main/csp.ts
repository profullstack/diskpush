import { createHash } from 'node:crypto'

/**
 * The inline scripts Next's export ships, as CSP source expressions.
 *
 * A static export carries its Flight payload in inline `<script>` tags
 * (`self.__next_f.push(...)`). Under `script-src 'self'` Chromium refuses every
 * one of them, so React boots with no payload and renders nothing: a blank
 * window. Hashing them keeps the policy strict — `'unsafe-inline'` would admit
 * any injected script, and a nonce cannot work here because the HTML is a file
 * on disk that is not regenerated per load.
 *
 * Matches any `<script>` without a `src`, whatever its other attributes, so an
 * attribute Next adds later cannot silently drop a script out of the policy.
 */
export function inlineScriptHashes(html: string): string[] {
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
  const hashes = scripts
    .map((match) => match[1] ?? '')
    .filter((body) => body !== '')
    .map((body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  return [...new Set(hashes)]
}

/**
 * The window's Content-Security-Policy.
 *
 * The renderer reaches the outside world only through IPC, so everything is
 * pinned to the bundle's own origin; `scriptHashes` admits the export's inline
 * payload and nothing else.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[] = []): string {
  return [
    "default-src 'self'",
    // Next's exported bundle inlines a small amount of style.
    "style-src 'self' 'unsafe-inline'",
    ["script-src 'self'", ...scriptHashes].join(' '),
    "img-src 'self' data:",
    "font-src 'self' data:",
    // The renderer talks to the main process over IPC, not the network.
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}
