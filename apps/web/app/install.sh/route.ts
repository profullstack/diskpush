import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SITE } from '@/lib/site'

/**
 * The installer, for `curl -fsSL https://diskpush.com/install.sh | sh`.
 *
 * Served from the repository's own scripts/install.sh rather than a copy, so
 * the script people pipe into a shell is the one in version control that they
 * can read on GitHub. The site URL baked into it is this deployment's, so an
 * installer served from a preview installs from that preview rather than
 * silently from production.
 */
export const dynamic = 'force-static'

const SCRIPT = join(process.cwd(), '..', '..', 'scripts', 'install.sh')

export async function GET() {
  const source = await readFile(SCRIPT, 'utf8')
  const script = source.replace('SITE="${DISKPUSH_SITE:-https://diskpush.com}"', `SITE="\${DISKPUSH_SITE:-${SITE.url}}"`)

  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'access-control-allow-origin': '*',
      // Short: this URL is printed on the homepage, and a stale installer
      // pointing at a moved release is the one failure nobody can debug.
      'cache-control': 'public, max-age=300',
    },
  })
}
