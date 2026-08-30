import { build } from 'esbuild'

/**
 * The preload script, bundled to a single CommonJS file.
 *
 * A sandboxed preload cannot be an ES module, and this package is ESM, so it
 * is emitted as `.cjs` to override the nearest package.json. Bundling means it
 * needs no node_modules beside it inside the asar.
 */
await build({
  entryPoints: ['electron/preload/index.ts'],
  outfile: 'dist-electron/preload/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Provided by the runtime, never bundled.
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
})
