#!/usr/bin/env node
/**
 * Builds the desktop packages.
 *
 * electron-builder cannot pack a pnpm workspace app directly: the workspace
 * dependencies are symlinks pointing outside the app directory, and asar
 * refuses any path that is not under it. `pnpm deploy` materialises them into
 * a staging directory whose node_modules is self-contained, and the build runs
 * from there.
 *
 * Run scripts/package-cli.mjs first: it produces the CLI copy this embeds.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const desktop = join(root, 'apps/desktop')
const outDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'release')

// Under the home cache, not /tmp: this machine's /tmp is a tmpfs too small for
// an unpacked Electron app plus the squashfs the AppImage target stages there.
const cache = join(homedir(), '.cache')
const stage = join(cache, 'diskpush-desktop-stage')
const buildTmp = join(cache, 'diskpush-build-tmp')

function run(command, args, cwd, env = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd, env: { ...process.env, CI: 'true', ...env } })
}

if (!existsSync(join(desktop, 'resources/cli/dist/bin.js'))) {
  console.error('resources/cli is missing. Run scripts/package-cli.mjs first.')
  process.exit(1)
}

// A stale Next cache from a previous build crashes webpack's wasm hashing
// with "Cannot read properties of undefined (reading 'length')", which reads
// as a code error rather than the cache problem it is.
console.log('cleaning previous build output...')
for (const dir of ['out', '.next', 'dist-electron', 'tsconfig.tsbuildinfo']) {
  rmSync(join(desktop, dir), { recursive: true, force: true })
}

console.log('building renderer and electron...')
run('pnpm', ['--filter', '@diskpush/desktop', 'build'], root)

console.log('staging a self-contained app...')
rmSync(stage, { recursive: true, force: true })
run('pnpm', ['deploy', '--filter', '@diskpush/desktop', '--legacy', stage], root)

mkdirSync(buildTmp, { recursive: true })
const targets = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['AppImage', 'deb', 'tar.gz']

console.log(`packaging: ${targets.join(', ')}`)
// --publish never: CI=true (needed so pnpm does not stop for a TTY prompt)
// also makes electron-builder try to upload to a draft GitHub release, which
// fails the build after every artifact has already been written correctly.
run(
  './node_modules/.bin/electron-builder',
  ['--linux', ...targets, '--publish', 'never', `-c.directories.output=${outDir}`],
  stage,
  { TMPDIR: buildTmp },
)

console.log(`\nartifacts in ${outDir}`)
