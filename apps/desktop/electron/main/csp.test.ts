import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, inlineScriptHashes } from './csp.js'

const sha256 = (body: string) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`

describe('inlineScriptHashes', () => {
  it('hashes the Flight payload scripts a Next export ships', () => {
    // The bug this exists to prevent: under script-src 'self' these are refused,
    // React boots with no payload, and the window is blank.
    const body = '(self.__next_f=self.__next_f||[]).push([0])'
    expect(inlineScriptHashes(`<html><body><script>${body}</script></body></html>`)).toEqual([sha256(body)])
  })

  it('ignores scripts that load from a src', () => {
    const html = '<script src="/_next/static/chunks/main.js"></script>'
    expect(inlineScriptHashes(html)).toEqual([])
  })

  it('still hashes an inline script that carries other attributes', () => {
    // An attribute Next adds later must not silently drop a script out of the policy.
    const html = '<script type="text/javascript" defer>alert(1)</script>'
    expect(inlineScriptHashes(html)).toEqual([sha256('alert(1)')])
  })

  it('does not mistake a src on a later tag for one on this tag', () => {
    const html = '<script>a()</script><script src="/x.js"></script>'
    expect(inlineScriptHashes(html)).toEqual([sha256('a()')])
  })

  it('collapses duplicates and skips empty scripts', () => {
    const html = '<script>x()</script><script>x()</script><script></script>'
    expect(inlineScriptHashes(html)).toEqual([sha256('x()')])
  })
})

describe('contentSecurityPolicy', () => {
  it('puts the hashes in script-src', () => {
    const policy = contentSecurityPolicy(["'sha256-abc'", "'sha256-def'"])
    const directive = policy.split('; ').find((d) => d.startsWith('script-src'))
    expect(directive).toBe("script-src 'self' 'sha256-abc' 'sha256-def'")
  })

  it('never admits inline script wholesale', () => {
    // 'unsafe-inline' would let an injected script run, which is the thing the
    // hashes exist to avoid.
    const directive = contentSecurityPolicy(["'sha256-abc'"])
      .split('; ')
      .find((d) => d.startsWith('script-src'))
    expect(directive).not.toContain('unsafe-inline')
  })

  it('keeps the rest of the policy pinned to the bundle', () => {
    const policy = contentSecurityPolicy()
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("frame-src 'none'")
    // Inline style is what the export genuinely needs, and only style.
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
  })
})
