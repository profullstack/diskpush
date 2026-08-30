import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { contentTypeFor, resolveBundlePath } from './bundle-path.js'

const ROOT = '/opt/diskpush/out'

describe('resolveBundlePath', () => {
  it('serves index.html for the origin root', () => {
    expect(resolveBundlePath(ROOT, '/')).toBe(join(ROOT, 'index.html'))
  })

  it('resolves the root-absolute asset paths Next emits', () => {
    // The whole reason the bundle scheme exists: under file:// these resolved
    // against the filesystem root and every one of them 404'd.
    expect(resolveBundlePath(ROOT, '/_next/static/css/app.css')).toBe(join(ROOT, '_next/static/css/app.css'))
    expect(resolveBundlePath(ROOT, '/_next/static/chunks/main-app.js')).toBe(join(ROOT, '_next/static/chunks/main-app.js'))
  })

  it('decodes percent-escapes in a filename', () => {
    expect(resolveBundlePath(ROOT, '/_next/a%20b.css')).toBe(join(ROOT, '_next/a b.css'))
  })

  it('refuses to escape the bundle', () => {
    for (const attempt of ['/../../../etc/passwd', '/_next/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      expect(resolveBundlePath(ROOT, attempt)).toBeNull()
    }
  })

  it('refuses a malformed escape and an embedded NUL', () => {
    expect(resolveBundlePath(ROOT, '/%')).toBeNull()
    expect(resolveBundlePath(ROOT, '/index.html%00.png')).toBeNull()
  })

  it('does not treat a sibling directory as inside the bundle', () => {
    // String-prefix checks without a separator let /opt/diskpush/outside through.
    expect(resolveBundlePath('/opt/diskpush/out', '/../outside/secret')).toBeNull()
  })
})

describe('contentTypeFor', () => {
  it('types the assets a Next export is made of', () => {
    // Served as octet-stream, a stylesheet is a stylesheet the renderer ignores.
    expect(contentTypeFor('/out/_next/static/css/app.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/out/_next/static/chunks/main.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/out/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/out/_next/static/media/geist.woff2')).toBe('font/woff2')
  })

  it('ignores case in the extension', () => {
    expect(contentTypeFor('/out/LOGO.PNG')).toBe('image/png')
  })

  it('falls back for anything unrecognised', () => {
    expect(contentTypeFor('/out/data.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('/out/LICENSE')).toBe('application/octet-stream')
  })
})
