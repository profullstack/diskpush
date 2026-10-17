/**
 * Just enough XML for S3's responses: they are flat, generated, and never
 * carry attributes or CDATA that matter here. Element names are matched
 * exactly and contents are entity-decoded.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity] ?? ''
  })
}

/** The raw inner text of every `<tag>…</tag>` in `xml`, in order. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = []
  const open = `<${tag}>`
  const close = `</${tag}>`
  let from = 0
  for (;;) {
    const start = xml.indexOf(open, from)
    if (start === -1) break
    const end = xml.indexOf(close, start + open.length)
    if (end === -1) break
    out.push(xml.slice(start + open.length, end))
    from = end + close.length
  }
  return out
}

/** The decoded text of the first `<tag>`, or null. */
export function xmlText(xml: string, tag: string): string | null {
  const [first] = xmlBlocks(xml, tag)
  return first === undefined ? null : decodeXml(first)
}
