import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The package is ESM for Next's sake, but the Electron main and preload
 * bundles are compiled to CommonJS: a sandboxed preload script cannot be an
 * ES module, and Electron resolves it by file rather than by package. This
 * marker tells Node to read dist-electron as CommonJS regardless.
 */
writeFileSync(join(process.cwd(), 'dist-electron', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`)
