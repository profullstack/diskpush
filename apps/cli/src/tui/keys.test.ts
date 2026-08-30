import { describe, expect, it } from 'vitest'
import { isChar, parseKeys } from './keys.js'

const ESC = String.fromCharCode(27)

describe('parseKeys', () => {
  it('reads arrow keys as single keys, not as escape then junk', () => {
    // The bug this prevents: reading byte by byte sees the escape first, and
    // if escape quits, every arrow key closes the program.
    expect(parseKeys(`${ESC}[A`)).toEqual(['up'])
    expect(parseKeys(`${ESC}[B`)).toEqual(['down'])
    expect(parseKeys(`${ESC}[C`)).toEqual(['right'])
    expect(parseKeys(`${ESC}[D`)).toEqual(['left'])
  })

  it('treats an escape arriving alone as the escape key', () => {
    expect(parseKeys(ESC)).toEqual(['escape'])
  })

  it('reads the application-mode form some terminals send', () => {
    expect(parseKeys(`${ESC}OA`)).toEqual(['up'])
  })

  it('reads page and home keys', () => {
    expect(parseKeys(`${ESC}[5~`)).toEqual(['page-up'])
    expect(parseKeys(`${ESC}[6~`)).toEqual(['page-down'])
    expect(parseKeys(`${ESC}[H`)).toEqual(['home'])
    expect(parseKeys(`${ESC}[F`)).toEqual(['end'])
  })

  it('reads ordinary characters', () => {
    expect(parseKeys('q')).toEqual([{ char: 'q' }])
    expect(parseKeys('jk')).toEqual([{ char: 'j' }, { char: 'k' }])
  })

  it('reads enter and tab', () => {
    expect(parseKeys('\r')).toEqual(['enter'])
    expect(parseKeys('\n')).toEqual(['enter'])
    expect(parseKeys('\t')).toEqual(['tab'])
  })

  it('handles several keys arriving in one chunk', () => {
    expect(parseKeys(`${ESC}[Bj${ESC}[A`)).toEqual(['down', { char: 'j' }, 'up'])
  })

  it('ignores an unrecognised escape sequence rather than quitting', () => {
    // Alt+x and friends must not be mistaken for the escape key.
    expect(parseKeys(`${ESC}x`)).toEqual([])
  })

  it('drops a truncated sequence instead of emitting a stray escape', () => {
    expect(parseKeys(`${ESC}[`)).toEqual([])
  })
})

describe('isChar', () => {
  it('matches a character key', () => {
    expect(isChar({ char: 'q' }, 'q')).toBe(true)
    expect(isChar({ char: 'j' }, 'q')).toBe(false)
    expect(isChar('up', 'q')).toBe(false)
  })
})
