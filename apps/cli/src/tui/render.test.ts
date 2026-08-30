import { describe, expect, it } from 'vitest'
import { formatSize, pad, truncate, width } from './render.js'

const ESC = String.fromCharCode(27)

describe('width', () => {
  it('ignores escape sequences, which occupy no columns', () => {
    expect(width(`${ESC}[7mhi${ESC}[0m`)).toBe(2)
  })
})

describe('truncate', () => {
  it('keeps the end of a path, which is the part that identifies it', () => {
    expect(truncate('a/very/long/path/to/file.txt', 12)).toBe('…to/file.txt')
  })

  it('leaves short text alone', () => {
    expect(truncate('short', 12)).toBe('short')
  })

  it('does not throw on a zero or negative budget', () => {
    // A terminal reporting 0 columns used to reach String.repeat with a
    // negative count and crash the whole TUI.
    expect(() => truncate('abc', 0)).not.toThrow()
    expect(() => truncate('abc', -5)).not.toThrow()
  })
})

describe('pad', () => {
  it('pads to the requested width', () => {
    expect(pad('ab', 5)).toBe('ab   ')
  })

  it('never emits a negative-length pad', () => {
    expect(() => pad('abcdef', -3)).not.toThrow()
  })
})

describe('formatSize', () => {
  it('uses bytes below a thousand', () => {
    expect(formatSize(512)).toBe('512B')
  })

  it('steps up units', () => {
    expect(formatSize(2048)).toBe('2.0K')
    expect(formatSize(5_400_000)).toBe('5.4M')
  })
})
