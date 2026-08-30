import { createRequire } from 'node:module'

/**
 * The version, read from this package's own manifest.
 *
 * Not a literal: a hardcoded copy is one more place a release has to remember
 * to edit, and the one place nothing fails loudly when it forgets — the CLI
 * would simply report the wrong version forever.
 */
const require = createRequire(import.meta.url)
const manifest = require('../package.json') as { version?: string }

export const VERSION: string = manifest.version ?? '0.0.0'
