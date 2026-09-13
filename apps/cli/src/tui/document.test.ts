import { describe, expect, it } from 'vitest'
import { themes } from '@profullstack/hqtui'
import { spanText } from '@profullstack/hqtui'
import { documentLines, maxScroll, readsAsMarkdown } from './document.js'
import { blankDocument, fillDocument, type Document } from './model.js'

const theme = themes.dark

function doc(name: string, text: string, size = Buffer.byteLength(text)): Document {
  const d = blankDocument('left', name, `/x/${name}`)
  fillDocument(d, { bytes: Buffer.from(text), size }, readsAsMarkdown)
  return d
}

describe('rendering a document', () => {
  it('renders markdown through readm3, with roles turned into theme colours', () => {
    const lines = documentLines(doc('README.md', '# Title\n\nSome **bold** text.\n'), 60, theme)
    const text = lines.map(spanText)
    expect(text[0]).toBe('Title')
    expect(lines[0]?.[0]?.fg).toEqual(theme.title)
    expect(text.some((line) => line.includes('Some bold text.'))).toBe(true)
    const bold = lines.flat().find((span) => span.text === 'bold')
    expect(bold?.bold).toBe(true)
  })

  it('shows text as numbered lines, tabs widened, and no phantom last line', () => {
    const lines = documentLines(doc('a.ts', 'const a = 1\n\tconst b = 2\n'), 60, theme).map(spanText)
    expect(lines).toEqual(['1 │ const a = 1', '2 │     const b = 2'])
  })

  it('shows a binary as a hex dump', () => {
    const lines = documentLines(doc('a.bin', 'AB\0C'), 60, theme).map(spanText)
    expect(lines).toEqual(['00000000  41 42 00 43                                       |AB.C|'])
  })

  it('caches by width, and re-renders when the width changes', () => {
    const d = doc('README.md', '# Title\n\n' + 'word '.repeat(40) + '\n')
    const narrow = documentLines(d, 40, theme)
    expect(documentLines(d, 40, theme)).toBe(narrow)
    const wide = documentLines(d, 120, theme)
    expect(wide).not.toBe(narrow)
    expect(wide.length).toBeLessThan(narrow.length)
  })

  it('never scrolls past the last screenful', () => {
    expect(maxScroll(100, 20)).toBe(80)
    expect(maxScroll(10, 20)).toBe(0)
    expect(maxScroll(5, 0)).toBe(4)
  })
})

describe('what an extensionless file is', () => {
  it('takes a README that reads as markdown for markdown', () => {
    expect(readsAsMarkdown('# Notes\n\n- one\n- two\n\nSee [the docs](https://example.com).\n')).toBe(true)
  })

  it('leaves a shell script alone', () => {
    expect(readsAsMarkdown('#!/bin/sh\nset -e\nfor f in *; do echo "$f"; done\n')).toBe(false)
  })
})
