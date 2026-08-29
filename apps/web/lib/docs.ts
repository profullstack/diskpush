import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { marked } from 'marked'

/**
 * Docs are read from the repository's own `docs/` directory at build time.
 *
 * There is deliberately no second copy of the documentation for the website:
 * a change to the product's docs is a change to the site, and the two cannot
 * drift apart.
 */
const DOCS_DIR = join(process.cwd(), '..', '..', 'docs')

export type DocMeta = { slug: string; title: string; description: string }

/** Ordered so the sidebar reads as a path through the product, not alphabetically. */
const ORDER = [
  'getting-started',
  'defaults',
  'cli',
  'desktop',
  'file-browser',
  'rsync-options',
  'profiles',
  'direct-server-to-server',
  'security',
  'architecture',
  'troubleshooting',
]

const DESCRIPTIONS: Record<string, string> = {
  'getting-started': 'From an empty config to a working transfer.',
  defaults: 'What DiskPush does when you tell it nothing, and why.',
  cli: 'The full command grammar, options and exit codes.',
  desktop: 'The two-pane app, the queue, and mirror safety.',
  'file-browser': 'Why browsing is SFTP and transferring is rsync.',
  'rsync-options': 'Every option, the flag it maps to, and its caveats.',
  profiles: 'Saved, repeatable directory pairs.',
  'direct-server-to-server': 'How the no-relay guarantee is implemented.',
  security: 'The threat model and the decisions that follow from it.',
  architecture: 'Packages, processes and boundaries.',
  troubleshooting: 'What the errors mean and what to do about them.',
}

export async function listDocs(): Promise<DocMeta[]> {
  const files = await readdir(DOCS_DIR)
  const slugs = files.filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, ''))

  const ordered = [...slugs].sort((a, b) => {
    const ia = ORDER.indexOf(a)
    const ib = ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  return Promise.all(
    ordered.map(async (slug) => ({
      slug,
      title: await readTitle(slug),
      description: DESCRIPTIONS[slug] ?? '',
    })),
  )
}

async function readTitle(slug: string): Promise<string> {
  const source = await readFile(join(DOCS_DIR, `${slug}.md`), 'utf8')
  const heading = /^#\s+(.+)$/m.exec(source)
  return heading?.[1] ?? slug
}

export async function readDoc(slug: string): Promise<{ title: string; html: string } | null> {
  // The slug comes from the URL. Anything that is not a plain doc name is not
  // a doc, and is certainly not a path to read.
  if (!/^[a-z0-9-]+$/.test(slug)) return null

  let source: string
  try {
    source = await readFile(join(DOCS_DIR, `${slug}.md`), 'utf8')
  } catch {
    return null
  }

  const title = /^#\s+(.+)$/m.exec(source)?.[1] ?? slug
  // Rewrite inter-document links so `defaults.md` resolves to `/docs/defaults`.
  const rewritten = source.replace(/\]\((?!https?:)([a-z0-9-]+)\.md(#[a-z0-9-]*)?\)/gi, '](/docs/$1$2)')
  const html = await marked.parse(rewritten, { gfm: true, async: true })
  return { title, html }
}
