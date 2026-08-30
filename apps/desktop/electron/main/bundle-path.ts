import { extname, join, normalize, sep } from 'node:path'

/**
 * Maps a bundle-scheme pathname to a file inside the exported renderer, or
 * null when it escapes.
 *
 * Kept apart from index.ts so the tests can import it: index.ts registers a
 * privileged scheme at module scope, so importing it outside Electron throws.
 */
export function resolveBundlePath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // A malformed escape is not a path we should guess at.
    return null
  }
  // A NUL byte truncates the path in some syscalls; refuse rather than normalise.
  if (decoded.includes('\0')) return null

  const target = normalize(join(root, decoded === '/' ? 'index.html' : decoded))
  // A crafted ../ must not turn the bundle scheme into a reader for the disk.
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

/**
 * Content types for what a Next export actually contains.
 *
 * The bundle is read with fs rather than `net.fetch('file://…')` because the
 * packaged app is an asar archive: fs is asar-aware, so it reads straight out
 * of it, and nothing here has to know whether the app is packaged. That means
 * the response carries no type of its own, and a stylesheet served as
 * octet-stream is a stylesheet the renderer ignores.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}
