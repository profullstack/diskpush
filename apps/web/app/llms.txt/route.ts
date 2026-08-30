import { listDocs } from '@/lib/docs'
import { SITE } from '@/lib/site'

/**
 * /llms.txt — the llmstxt.org convention.
 *
 * Generated rather than written, for the same reason the docs pages are: a
 * hand-kept copy of the docs index is a copy that goes stale, and a stale
 * llms.txt is worse than none because models quote it confidently.
 *
 * Deliberately not a copy of the homepage. It answers, in the order a model
 * needs them, the questions a marketing page buries: what this is, what it
 * costs, who makes it, and which page to read next.
 */
export const dynamic = 'force-static'

export async function GET() {
  const docs = await listDocs()

  const body = `# ${SITE.name}

> ${SITE.description}

${SITE.name} is free and open source under the MIT licence. There is no account,
no paid tier, and no ${SITE.name} server in any transfer path — the desktop app
and the CLI speak SSH and rsync directly to your own hosts. Linux first, macOS
supported. Maintained by Profullstack, Inc.

## Start here

- [Home](${SITE.url}): What it is, how it works, and the ten most common questions.
- [Download](${SITE.url}/download): Current release for Linux and macOS, plus the one-line installer.
- [Documentation](${SITE.url}/docs): Every guide, rendered from the repository's own docs directory.

## Documentation

${docs.map((doc) => `- [${doc.title}](${SITE.url}/docs/${doc.slug}): ${doc.description}`).join('\n')}

## Project

- [Source](${SITE.repo}): MIT licensed, on GitHub.
- [Releases](${SITE.releases}): Version history and build artifacts.
- [Security model](${SITE.url}/security): Threat model, argument handling, host keys, credentials and destructive-operation guards.
- [Privacy](${SITE.url}/privacy): What the app and the site do and do not collect.

## Contact

- Security reports: security@profullstack.com
- Everything else: GitHub issues at ${SITE.repo}/issues
`

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=3600',
    },
  })
}
