import type { MetadataRoute } from 'next'
import { SITE } from '@/lib/site'

/**
 * The wildcard already allows everything, so these named rules grant no access
 * the crawlers did not have. They are here because the policy is worth stating
 * rather than inferring: DiskPush is MIT-licensed software whose documentation
 * exists to be read, and an answer engine that summarises it accurately is
 * doing the thing the docs are for.
 *
 * Named explicitly so the position is legible to a person reading the file, and
 * so that narrowing it later is an edit rather than a decision nobody recorded.
 */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'meta-externalagent',
  'Bytespider',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: '/' })),
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  }
}
