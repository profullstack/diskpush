#!/usr/bin/env node
/**
 * Cuts a release.
 *
 *   pnpm release patch|minor|major
 *   pnpm release 0.2.0
 *
 * Bumps every manifest, runs the checks, commits, tags, and pushes with
 * --follow-tags. Pushing the tag is what builds and publishes the artifacts;
 * see .github/workflows/release.yml.
 *
 * Every guard runs BEFORE anything is written, so a refusal leaves a clean
 * tree rather than a half-bumped one you have to unpick.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

// The tag tracks the CLI. Artifact filenames come from these manifests, so
// they are kept in step deliberately rather than by luck.
const MANIFESTS = [
  'apps/cli/package.json',
  'apps/desktop/package.json',
  'apps/web/package.json',
  'packages/schemas/package.json',
  'packages/rsync-core/package.json',
  'packages/ssh-core/package.json',
  'packages/database/package.json',
]
const TAG_SOURCE = 'apps/cli/package.json'

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
}

function readManifest(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'))
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`cannot parse version ${JSON.stringify(version)}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function bump(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [major, minor, patch] = parse(version)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown release kind ${JSON.stringify(kind)}; use patch, minor, major or an explicit version`)
}

function compare(a, b) {
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

const kind = process.argv[2]
if (!kind) {
  console.error('usage: pnpm release <patch|minor|major|X.Y.Z>')
  process.exit(64)
}

// --- guards, all before any write -------------------------------------------

if (git('status', '--porcelain') !== '') {
  console.error('working tree is dirty; commit or stash first.')
  process.exit(1)
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  console.error(`releases are cut from main; you are on ${branch}.`)
  process.exit(1)
}

const current = readManifest(TAG_SOURCE).version
const next = bump(current, kind)
const tag = `v${next}`

const tags = git('tag', '--list').split('\n').filter(Boolean)
if (tags.includes(tag)) {
  console.error(`${tag} already exists. Releases are not re-cut; bump again.`)
  process.exit(1)
}

const newest = tags
  .filter((candidate) => /^v\d+\.\d+\.\d+$/.test(candidate))
  .map((candidate) => candidate.slice(1))
  .sort(compare)
  .at(-1)

if (newest && compare(next, newest) <= 0) {
  console.error(`${next} does not sort above the newest release (${newest}).`)
  console.error('Publishing backwards drags "latest" onto an older build, which cannot be undone.')
  process.exit(1)
}

// Versions must agree across manifests, because artifact filenames come from
// them: a desktop manifest left behind ships DiskPush-0.1.0.AppImage under
// tag v0.2.0, and nobody can tell which build they have.
const drifted = MANIFESTS.filter((relative) => readManifest(relative).version !== current)
if (drifted.length > 0) {
  console.error('these manifests are not on the same version as the CLI:')
  for (const relative of drifted) console.error(`  ${relative}: ${readManifest(relative).version} (cli: ${current})`)
  process.exit(1)
}

console.log(`${current} -> ${next}\n`)

// --- write, verify, commit ---------------------------------------------------

for (const relative of MANIFESTS) {
  const path = join(root, relative)
  const source = readFileSync(path, 'utf8')
  const manifest = JSON.parse(source)
  manifest.version = next
  // Re-serialising loses nothing here: every manifest in this repo is written
  // by tooling and two-space indented.
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`  ${relative}`)
}

console.log('\nverifying...')
run('pnpm', ['install', '--no-frozen-lockfile'])
run('pnpm', ['build'])
run('pnpm', ['-r', 'typecheck'])
run('pnpm', ['test'])

git('add', '-A')
execFileSync('git', ['commit', '-m', `chore(release): ${tag}`], { cwd: root, stdio: 'inherit' })
execFileSync('git', ['tag', '-a', tag, '-m', `DiskPush ${next}`], { cwd: root, stdio: 'inherit' })

console.log(`\nTagged ${tag}. Push it to build and publish:\n\n  git push --follow-tags\n`)
