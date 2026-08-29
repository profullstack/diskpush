import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { VERSION } from './help.js'
import type { Output } from './output.js'
import { readManifest, stateDirectory } from './commands/self.js'

/**
 * Startup update check.
 *
 * Rate-limited rather than run on every invocation: a CLI that makes a network
 * request before each command is a CLI that hangs whenever GitHub is slow, and
 * `diskpush` is the kind of thing people put in a loop.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const RELEASES_API = 'https://api.github.com/repos/profullstack/diskpush/releases/latest'

function stampPath(): string {
  return join(stateDirectory(), 'last-update-check')
}

function readStamp(): number {
  try {
    return Number(readFileSync(stampPath(), 'utf8').trim()) || 0
  } catch {
    return 0
  }
}

function writeStamp(): void {
  try {
    mkdirSync(dirname(stampPath()), { recursive: true })
    writeFileSync(stampPath(), String(Date.now()))
  } catch {
    // A cache we cannot write is a check that runs more often, not an error.
  }
}

/** Compares dotted versions numerically, so 0.10.0 is newer than 0.9.0. */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

async function latestVersion(timeoutMs = 4000): Promise<string | null> {
  try {
    const response = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `diskpush/${VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const release = (await response.json()) as { tag_name?: string; draft?: boolean }
    if (!release.tag_name || release.draft) return null
    return release.tag_name.replace(/^v/, '')
  } catch {
    // Offline, rate-limited, slow: none of these should stop the command the
    // user actually typed.
    return null
  }
}

export type AutoUpdateOutcome = 'skipped' | 'current' | 'updated' | 'failed'

/**
 * Checks for a newer release and installs it before the requested command
 * runs, so the command executes on the version it just installed.
 *
 * Deliberately does nothing when: the copy was not installed by the installer,
 * output is machine-readable, the command is one where a surprise upgrade
 * would be wrong, or DISKPUSH_NO_AUTO_UPDATE is set.
 */
export async function autoUpdate(command: string | null, output: Output, force = false): Promise<AutoUpdateOutcome> {
  if (process.env.DISKPUSH_NO_AUTO_UPDATE) return 'skipped'
  // --json output is parsed by scripts; a progress line in it is a bug.
  if (output.isJson) return 'skipped'
  // Updating inside these would be circular, surprising, or both.
  if (command && ['update', 'upgrade', 'uninstall', 'remove', 'version', 'help', 'doctor'].includes(command)) {
    return 'skipped'
  }

  const manifest = readManifest()
  if (!manifest || manifest.method === 'source') return 'skipped'

  if (!force && Date.now() - readStamp() < CHECK_INTERVAL_MS) return 'skipped'
  writeStamp()

  const latest = await latestVersion()
  if (!latest) return 'skipped'
  if (!isNewer(latest, VERSION)) return 'current'

  output.warn(`DiskPush ${latest} is available (you have ${VERSION}). Updating...`)

  const script = spawnSync('sh', ['-c', `curl -fsSL ${manifest.installer} || wget -qO- ${manifest.installer}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (script.status !== 0 || !script.stdout) {
    output.warn('Update check failed to download the installer; continuing on the current version.')
    return 'failed'
  }

  const run = spawnSync('sh', ['-s', '--', ...(manifest.desktop ? [] : ['--cli-only'])], {
    input: script.stdout,
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  if (run.status !== 0) {
    output.warn('Update failed; continuing on the current version.')
    return 'failed'
  }

  output.warn(`Updated to ${latest}.`)
  return 'updated'
}

/**
 * Re-runs the original command on the freshly installed version.
 *
 * Without this the process would carry on executing the code it loaded at
 * startup, which is the old version — so the update would appear to have had
 * no effect until the next invocation.
 */
export function reexec(): never {
  const manifest = readManifest()
  const binary = manifest ? join(dirname(stateDirectory()), '..', 'bin', 'diskpush') : null
  const target = binary && existsSync(binary) ? binary : process.argv[1]

  const result = spawnSync(target!, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, DISKPUSH_NO_AUTO_UPDATE: '1' },
  })
  process.exit(result.status ?? 0)
}
