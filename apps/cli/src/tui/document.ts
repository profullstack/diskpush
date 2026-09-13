/**
 * A document as lines the frame can draw.
 *
 * Markdown is rendered by readm3 — the same renderer readm3.com and the
 * `readm3` reader use — which hands back lines of spans carrying a semantic
 * role (`h1`, `code`, `link`…) rather than a colour, and its own `colorOf`
 * turns each role into a colour of the theme in use. Anything else that is
 * text is shown as numbered lines, and a binary as a hex dump of its head.
 *
 * Pure: a document and a width in, span lines out. Nothing here touches a
 * terminal, so a rendered document is assertable the way a frame is.
 */
import type { SpanLine, Theme } from '@profullstack/hqtui'
import { colorOf, renderMarkdown, type Span as MarkdownSpan } from '@profullstack/readm3'
import { detectTextFormat } from '@profullstack/text-type-detection'
import { type Document, hexDump } from './model.js'

/** Spaces a tab stands for. Code shows in terminals at eight; four reads better in a pane. */
const TAB = '    '

/**
 * A second opinion on an extensionless file: does the text read as markdown?
 *
 * `README`, `NOTES`, `TODO` — files people write in markdown and never name
 * that way. The detector is the house one, and only its markdown answer is
 * trusted; everything else it might say (`code`, `json`) is drawn as text anyway.
 */
export function readsAsMarkdown(text: string): boolean {
  return detectTextFormat(text).text_format === 'markdown'
}

function fromMarkdown(span: MarkdownSpan, theme: Theme): SpanLine[number] {
  return {
    text: span.text,
    fg: colorOf(span, theme),
    ...(span.bold ? { bold: true } : {}),
    ...(span.italic ? { italic: true } : {}),
    ...(span.underline ? { underline: true } : {}),
    ...(span.dim ? { dim: true } : {}),
  }
}

function render(doc: Document, width: number, theme: Theme): SpanLine[] {
  if (doc.kind === 'markdown') {
    return renderMarkdown(doc.text, Math.max(20, width)).map((line) => line.spans.map((span) => fromMarkdown(span, theme)))
  }
  if (doc.kind === 'binary') {
    return hexDump(doc.bytes).map((row) => [
      { text: row.slice(0, 8), fg: theme.muted },
      { text: row.slice(8), fg: theme.foreground },
    ])
  }
  const lines = doc.text.split('\n')
  // A trailing newline is how a text file ends, not an empty last line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const gutter = String(lines.length).length
  return lines.map((line, index) => [
    { text: `${String(index + 1).padStart(gutter)} `, fg: theme.muted },
    { text: '│ ', fg: theme.border },
    { text: line.replaceAll('\t', TAB), fg: theme.foreground },
  ])
}

/**
 * Rendered lines are cached per document and width. A megabyte of markdown
 * must not be parsed again on every frame, and a frame is drawn on every
 * mouse move.
 */
const rendered = new WeakMap<Document, { width: number; theme: string; lines: SpanLine[] }>()

export function documentLines(doc: Document, width: number, theme: Theme): SpanLine[] {
  const hit = rendered.get(doc)
  if (hit && hit.width === width && hit.theme === theme.name) return hit.lines
  const lines = render(doc, width, theme)
  rendered.set(doc, { width, theme: theme.name, lines })
  return lines
}

/** The furthest a document of `total` lines can scroll in `rows` rows. */
export function maxScroll(total: number, rows: number): number {
  return Math.max(0, total - Math.max(1, rows))
}
