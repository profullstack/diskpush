#!/usr/bin/env node
/**
 * Builds the self-contained CLI bundle.
 *
 * `pnpm deploy` flattens the workspace packages and their production
 * dependencies into one directory that runs from anywhere. The result is used
 * twice: as the headless install artifact, and as the copy embedded in the
 * desktop app, so an install with a GUI needs no system Node at all.
 *
 * It builds from a clean clone of HEAD rather than from the working tree, for
 * two reasons. A release artifact should contain what is committed and nothing
 * else; and `pnpm deploy --prod` runs a production install that leaves the
 * root workspace marked production-only, which strips the devDependencies the
 * tests need out from under you.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')).version
const outDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'release')

const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const name = `diskpush-cli-${version}-${platform}-${arch}`

const LAUNCHER = `#!/bin/sh
# DiskPush CLI launcher.
#
# Prefers the Node that shipped with the desktop install, so a machine with an
# old system Node (or none at all) still runs the CLI correctly. Falls back to
# a system Node for the CLI-only install.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"

if [ -x "$here/../app/diskpush" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$here/../app/diskpush" "$here/dist/bin.js" "$@"
fi

command -v node >/dev/null 2>&1 || {
  echo "diskpush: node is required for the CLI-only install. Install Node 24 or newer." >&2
  exit 69
}
exec node "$here/dist/bin.js" "$@"
`

function run(command, args, cwd, env = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd, env: { ...process.env, CI: 'true', ...env } })
}

// Under the home cache rather than /tmp, deliberately: pnpm keeps its
// content-addressable store in the home directory and can only hardlink from
// it within the same filesystem. A checkout on /tmp makes pnpm build a second
// store there and copy every package into it, which on this machine exhausts
// the quota partway through Electron.
const cacheRoot = join(homedir(), '.cache')
mkdirSync(cacheRoot, { recursive: true })
const work = mkdtempSync(join(cacheRoot, 'diskpush-release-'))
const checkout = join(work, 'src')

try {
  console.log(`cloning HEAD into ${checkout}`)
  run('git', ['clone', '--quiet', '--depth', '1', `file://${root}`, checkout], work)

  // Filtered to the CLI and its dependencies: a full install would pull
  // Electron, ~190MB the CLI artifact has no use for.
  console.log('installing (CLI and its dependencies only)...')
  run('pnpm', ['install', '--frozen-lockfile', '--filter', '@diskpush/cli...'], checkout)

  console.log('building...')
  run('pnpm', ['-r', '--filter', './packages/**', 'build'], checkout)
  run('pnpm', ['--filter', '@diskpush/cli', 'build'], checkout)

  console.log('deploying a self-contained CLI...')
  const stage = join(work, 'cli')
  // --legacy because these are ordinary workspace links rather than injected
  // dependencies; --prod so devDependencies stay out of the artifact.
  //
  // node-linker=hoisted is load-bearing. pnpm's default layout links each
  // package from node_modules/.pnpm, and those symlinks do not survive the
  // trip into an Electron bundle: electron-builder's extraResources copy drops
  // them, and the app ships an empty node_modules that fails at first run with
  // "Cannot find package '@diskpush/database'". A hoisted tree is plain
  // directories, the same 33MB, and survives any copy.
  run(
    'pnpm',
    ['deploy', '--filter', '@diskpush/cli', '--prod', '--legacy', '--config.node-linker=hoisted', stage],
    checkout,
  )

  writeFileSync(join(stage, 'diskpush'), LAUNCHER, { mode: 0o755 })

  mkdirSync(outDir, { recursive: true })
  console.log(`packing ${name}.tar.gz ...`)
  run('tar', ['-czf', join(outDir, `${name}.tar.gz`), '-C', work, '--transform', `s,^cli,${name},`, 'cli'], work)

  // The desktop build embeds this same tree, so both surfaces ship one build.
  const embedded = join(root, 'apps/desktop/resources/cli')
  rmSync(embedded, { recursive: true, force: true })
  // verbatimSymlinks: without it Node's cp resolves relative symlinks to
  // absolute paths, which would point into this script's temp directory - the
  // one deleted in the finally block below.
  cpSync(stage, embedded, { recursive: true, verbatimSymlinks: true })
  console.log(`embedded a copy at ${embedded}`)

  console.log(`\n${join(outDir, `${name}.tar.gz`)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
