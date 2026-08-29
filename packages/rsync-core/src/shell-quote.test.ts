import { describe, expect, it } from 'vitest'
import { shellJoin, shellQuote } from './shell-quote.js'

describe('shellQuote', () => {
  it('leaves ordinary path characters unquoted', () => {
    expect(shellQuote('/srv/media/movies')).toBe('/srv/media/movies')
    expect(shellQuote('--partial-dir=.rsync-partial')).toBe('--partial-dir=.rsync-partial')
  })

  it('quotes whitespace', () => {
    expect(shellQuote('/srv/my media')).toBe("'/srv/my media'")
  })

  it('neutralises command substitution', () => {
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'")
    expect(shellQuote('`id`')).toBe("'`id`'")
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'")
  })

  it('escapes an embedded single quote without ending the quoted run', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  it('quotes the empty string so it survives as an argument', () => {
    expect(shellQuote('')).toBe("''")
  })
})

describe('shellJoin', () => {
  it('produces a command a POSIX shell reads back as the original tokens', () => {
    expect(shellJoin(['rsync', '--archive', '/a b/', "prod:/x'y"])).toBe(
      `rsync --archive '/a b/' 'prod:/x'\\''y'`,
    )
  })
})
