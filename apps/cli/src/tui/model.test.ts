import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Entry,
  type Pane,
  blankPane,
  clampIndex,
  compareEntries,
  formatSize,
  formatWhen,
  pushChange,
  selectedEntry,
  visibleEntries,
  TRANSFER_LOG_LIMIT, DOCUMENT_LIMIT, blankDocument, decodeText, fillDocument, hexDump, isMarkdownName, isTruncated, looksBinary, readLocalHead } from './model.js'
import type { Transfer } from './model.js'

const entry = (name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  isDirectory: false,
  size: 0,
  modifiedAt: null,
  ...over,
})

function paneWith(entries: Entry[], over: Partial<Pane> = {}): Pane {
  return { ...blankPane('Local', '/tmp'), entries, ...over }
}

describe('visibleEntries', () => {
  it('hides dotfiles until they are asked for', () => {
    const pane = paneWith([entry('.env'), entry('app.ts')])
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['app.ts'])
    pane.showHidden = true
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['.env', 'app.ts'])
  })

  it('filters case-insensitively on a substring', () => {
    const pane = paneWith([entry('README.md'), entry('index.ts')], { filter: 'ME' })
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['README.md'])
  })

  it('keeps directories on top however the sort runs', () => {
    // Reversing a size sort must not bury the directories you navigate with
    // under the data, which is the whole reason they are pinned.
    const pane = paneWith(
      [entry('big.bin', { size: 9000 }), entry('src', { isDirectory: true }), entry('small.txt', { size: 1 })],
      { sort: 'size', descending: true },
    )
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['src', 'big.bin', 'small.txt'])
  })

  it('breaks ties on name, so equal sizes are not left in listing order', () => {
    const pane = paneWith([entry('b'), entry('a')], { sort: 'size' })
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['a', 'b'])
  })

  it('sorts by time when asked', () => {
    const pane = paneWith(
      [
        entry('old', { modifiedAt: '2020-01-01T00:00:00.000Z' }),
        entry('new', { modifiedAt: '2026-01-01T00:00:00.000Z' }),
      ],
      { sort: 'time', descending: true },
    )
    expect(visibleEntries(pane).map((e) => e.name)).toEqual(['new', 'old'])
  })
})

describe('the cursor', () => {
  it('indexes what is on screen, not the raw listing', () => {
    // A filter that removes everything above the cursor would otherwise select
    // a different file than the one under the highlight.
    const pane = paneWith([entry('a.ts'), entry('b.ts'), entry('c.ts')], { filter: 'c', index: 0 })
    expect(selectedEntry(pane)?.name).toBe('c.ts')
  })

  it('is pulled back onto a row that exists when the list shrinks', () => {
    const pane = paneWith([entry('a'), entry('b'), entry('c')], { index: 2 })
    pane.filter = 'a'
    clampIndex(pane)
    expect(pane.index).toBe(0)
  })

  it('is null on an empty listing rather than a phantom row', () => {
    expect(selectedEntry(paneWith([]))).toBeNull()
  })
})

describe('compareEntries', () => {
  it('orders names naturally when the sort is by name', () => {
    expect(compareEntries(entry('a'), entry('b'), 'name', false)).toBeLessThan(0)
    expect(compareEntries(entry('a'), entry('b'), 'name', true)).toBeGreaterThan(0)
  })
})

describe('formatSize', () => {
  it('stays narrow enough for the column it lives in', () => {
    expect(formatSize(999)).toBe('999B')
    expect(formatSize(1500)).toBe('1.5K')
    expect(formatSize(1_500_000)).toBe('1.5M')
    expect(formatSize(15_000_000)).toBe('15M')
  })
})

describe('formatWhen', () => {
  const now = new Date('2026-09-08T12:00:00.000Z')

  it('shows a clock for today and a year for anything old', () => {
    const today = new Date('2026-09-08T08:30:00.000Z')
    expect(formatWhen(today.toISOString(), now)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatWhen('2019-03-04T00:00:00.000Z', now)).toMatch(/^Mar 2019$/)
  })

  it('says nothing rather than "Invalid Date" when there is no timestamp', () => {
    expect(formatWhen(null, now)).toBe('')
    expect(formatWhen('not a date', now)).toBe('')
  })
})

describe('the transfer log', () => {
  const transfer = (): Transfer => ({
    mode: 'sync',
    from: '/a/',
    to: '/b/',
    running: true,
    progress: null,
    recent: [],
    summary: { add: 0, update: 0, metadata: 0, delete: 0, unchanged: 0, error: 0 },
    outcome: null,
    cancel: () => {},
  })

  it('counts every change but only keeps the last screenful', () => {
    // A million-file sync must not hold a million objects alive just to draw
    // the last twenty of them.
    const t = transfer()
    for (let i = 0; i < TRANSFER_LOG_LIMIT + 50; i += 1) {
      pushChange(t, { action: 'add', path: `file-${i}`, itemize: null, isDirectory: false, size: 1 })
    }
    expect(t.summary.add).toBe(TRANSFER_LOG_LIMIT + 50)
    expect(t.recent).toHaveLength(TRANSFER_LOG_LIMIT)
    expect(t.recent.at(-1)?.path).toBe(`file-${TRANSFER_LOG_LIMIT + 49}`)
  })
})

describe('documents', () => {
  const doc = (name: string, bytes: Uint8Array | string, size?: number, byContent = () => false) => {
    const d = blankDocument('left', name, `/x/${name}`)
    const raw = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
    fillDocument(d, { bytes: raw, size: size ?? raw.length }, byContent)
    return d
  }

  it('knows markdown by its extension, the way readm3 does', () => {
    for (const name of ['README.md', 'notes.markdown', 'a.MD', 'page.mdx']) expect(isMarkdownName(name)).toBe(true)
    for (const name of ['README', 'a.ts', 'md', 'a.md.bak']) expect(isMarkdownName(name)).toBe(false)
  })

  it('calls a head with a NUL in it binary, and text otherwise', () => {
    expect(looksBinary(Buffer.from('hello\n'))).toBe(false)
    expect(looksBinary(Buffer.from('hel\0lo'))).toBe(true)
    expect(looksBinary(new Uint8Array())).toBe(false)
    // Tabs, newlines and colour escapes are text; a head of other control bytes is not.
    expect(looksBinary(Buffer.from('\t\x1b[31mred\x1b[0m\r\n'))).toBe(false)
    expect(looksBinary(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 65, 66]))).toBe(true)
    // Noise without a NUL is still not text, and Latin-1 prose still is.
    expect(looksBinary(Uint8Array.from({ length: 300 }, (_, i) => 0x80 + ((i * 37) % 0x7f)))).toBe(true)
    expect(looksBinary(Buffer.from('Le caf\xe9 est pr\xeat, dit-elle, et la journ\xe9e commence.', 'latin1'))).toBe(false)
    expect(looksBinary(Buffer.from('Ünïcödé is fine, and so is 日本語 and emoji 🎉.'))).toBe(false)
  })

  it('decodes text, dropping a BOM and folding Windows line ends', () => {
    expect(decodeText(Buffer.from('﻿a\r\nb\rc\n'))).toBe('a\nb\nc\n')
  })

  it('dumps hex sixteen bytes to a row, gapped after eight, printable bytes alongside', () => {
    const rows = hexDump(Buffer.from('Hello, world!\n\0\xff!'))
    expect(rows).toEqual([
      '00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 00 c3  |Hello, world!...|',
      '00000010  bf 21                                             |.!|',
    ])
    expect(hexDump(new Uint8Array(10_000)).length).toBe(4096 / 16)
  })

  it('decides the kind by name first, and by content only for a file with no extension', () => {
    expect(doc('README.md', 'plain words').kind).toBe('markdown')
    expect(doc('a.ts', '# not a heading').kind).toBe('text')
    expect(doc('README', '# Notes', undefined, () => true).kind).toBe('markdown')
    expect(doc('a.txt', '# Notes', undefined, () => true).kind).toBe('text')
    expect(doc('a.md', 'x\0y').kind).toBe('binary')
  })

  it('knows when it holds only the head of a file', () => {
    expect(isTruncated(doc('big.log', 'first bytes', 5_000_000))).toBe(true)
    expect(isTruncated(doc('small.log', 'all of it'))).toBe(false)
  })

  it('reads only the head of a local file, and reports the whole size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diskpush-doc-'))
    const path = join(dir, 'big.txt')
    writeFileSync(path, 'x'.repeat(5000))
    const head = readLocalHead(path, 100)
    expect(head.bytes.length).toBe(100)
    expect(head.size).toBe(5000)
    const whole = readLocalHead(path, DOCUMENT_LIMIT)
    expect(whole.bytes.length).toBe(5000)
    expect(DOCUMENT_LIMIT).toBe(1024 * 1024)
  })
})
