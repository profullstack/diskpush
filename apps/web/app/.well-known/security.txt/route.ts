import { SITE } from '@/lib/site'

/**
 * /.well-known/security.txt — RFC 9116.
 *
 * The disclosure address was already published in prose on /security; this is
 * the same fact where a scanner looks for it.
 *
 * Expires is required by the RFC and must be in the future, so it is computed
 * rather than written down: a hard-coded date is a file that silently becomes
 * invalid on a day nobody has in their calendar. A year out, recomputed on each
 * deploy, means it stays valid as long as the site is maintained — and goes
 * stale only once the site itself has been abandoned, which is exactly the
 * signal the field is for.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const expires = new Date()
  expires.setUTCFullYear(expires.getUTCFullYear() + 1)

  const body = `Contact: mailto:security@profullstack.com
Expires: ${expires.toISOString()}
Preferred-Languages: en
Canonical: ${SITE.url}/.well-known/security.txt
Policy: ${SITE.url}/security
`

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=86400',
    },
  })
}
