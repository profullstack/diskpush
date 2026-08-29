import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../exit-codes.js'
import { table } from '../format.js'
import { failure, type Output } from '../output.js'
import { hasFlag, type ParsedArgv } from '../parse-argv.js'
import { VERSION } from '../help.js'

/**
 * Self-management: `diskpush update` and `diskpush uninstall`.
 *
 * The installer records what it did in a manifest and leaves an uninstall
 * script beside it. These commands read that record rather than guessing,
 * so removal is exact and works offline — a command that needs the network
 * to uninstall itself is a command you cannot get rid of on a plane.
 */

export type InstallManifest = {
  version: string
  /** How it was installed, which decides how it is removed. */
  method: 'appimage' | 'deb' | 'macos-app' | 'cli-tarball' | 'source'
  installer: string
  installedAt: string
  paths: string[]
  desktop: boolean
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DISKPUSH_HOME) return join(env.DISKPUSH_HOME, 'install')
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'diskpush')
}

export function manifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirectory(env), 'manifest.json')
}

export function readManifest(env: NodeJS.ProcessEnv = process.env): InstallManifest | null {
  const path = manifestPath(env)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstallManifest
  } catch {
    return null
  }
}

/**
 * Re-runs the installer that put this copy here. It is idempotent, so
 * updating is installing again, and the manifest remembers where it came
 * from — an installer served from a preview deployment keeps updating from
 * that preview rather than silently switching to production.
 */
export async function runUpdate(parsed: ParsedArgv, output: Output): Promise<number> {
  const manifest = readManifest()

  if (!manifest) {
    return failure(
      output,
      'This copy of DiskPush was not installed by the installer, so there is nothing to update.\n' +
        'If you are running from a source checkout, use git pull and pnpm build.',
      EXIT.configuration,
    )
  }
  if (manifest.method === 'source') {
    return failure(output, 'This is a source checkout. Use git pull and pnpm build.', EXIT.configuration)
  }

  const installer = manifest.installer
  output.line(`Current version: ${VERSION}`)
  output.line(`Updating from ${installer}`)

  if (hasFlag(parsed, '--dry-run')) {
    output.line('Dry run: would re-run the installer, which upgrades in place.')
    return EXIT.ok
  }

  const fetcher = pickFetcher()
  if (!fetcher) return failure(output, 'curl or wget is required to update.', EXIT.unavailable)

  // Piped into sh exactly as the documented install line does, so update and
  // first install take the same path and cannot drift apart.
  const script = spawnSync(fetcher.binary, [...fetcher.args, installer], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (script.status !== 0 || !script.stdout) {
    return failure(output, `Could not download the installer from ${installer}.`, EXIT.unavailable)
  }

  const run = spawnSync('sh', ['-s', '--', ...(manifest.desktop ? [] : ['--cli-only'])], {
    input: script.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return run.status ?? EXIT.internal
}

export async function runUninstall(parsed: ParsedArgv, output: Output): Promise<number> {
  const manifest = readManifest()
  if (!manifest) {
    return failure(
      output,
      'No installation manifest found, so DiskPush was not installed by the installer.\n' +
        'Nothing was removed. A source checkout is removed by deleting the checkout.',
      EXIT.configuration,
    )
  }

  const script = join(stateDirectory(), 'uninstall.sh')
  output.line(`Installed: ${manifest.version} (${manifest.method}) on ${manifest.installedAt.slice(0, 10)}`)
  output.line('')
  output.line('These paths will be removed:')
  output.line(table(manifest.paths.map((path) => [path])))
  output.line('')
  output.line('Your connections, profiles and job history are NOT removed.')
  output.line(`They live in ${process.env.XDG_CONFIG_HOME ?? '~/.config'}/diskpush and can be deleted separately.`)

  if (hasFlag(parsed, '--dry-run')) {
    output.line('')
    output.line('Dry run: nothing was removed.')
    return EXIT.ok
  }

  if (!hasFlag(parsed, '--yes')) {
    if (!process.stdin.isTTY) {
      return failure(output, '\nRe-run with --yes to confirm removal.', EXIT.refused)
    }
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await rl.question('\nRemove DiskPush? [y/N] ')
      if (!/^y(es)?$/i.test(answer.trim())) {
        output.line('Cancelled.')
        return EXIT.ok
      }
    } finally {
      rl.close()
    }
  }

  if (!existsSync(script)) {
    return failure(output, `The uninstall script is missing from ${script}.`, EXIT.configuration)
  }

  // exec rather than reimplement: the installer wrote this script knowing
  // exactly what it created, including whether it used a package manager.
  const run = spawnSync('sh', [script], { stdio: 'inherit' })
  return run.status ?? EXIT.internal
}

/** `diskpush doctor`: what is installed, and is the environment sane. */
export async function runDoctor(_parsed: ParsedArgv, output: Output): Promise<number> {
  const manifest = readManifest()
  const rows: string[][] = [
    ['DiskPush', VERSION],
    ['Install method', manifest?.method ?? 'source or unmanaged'],
    ['Node', process.versions.node],
    ['Platform', `${process.platform} ${process.arch}`],
  ]

  const rsync = probe('rsync', ['--version'])
  rows.push(['rsync', rsync ? (/rsync\s+version\s+(\S+)/.exec(rsync)?.[1] ?? 'present') : 'MISSING — transfers will not work'])

  const ssh = probe('ssh', ['-V'])
  rows.push(['ssh', ssh ? ssh.trim().split('\n')[0]! : 'MISSING — remote transfers will not work'])

  rows.push(['SSH agent', process.env.SSH_AUTH_SOCK ? 'available' : 'not running'])

  output.line(table(rows))
  if (!rsync) {
    output.line('')
    output.line('Install rsync:  sudo apt install rsync openssh-client')
  }
  return rsync ? EXIT.ok : EXIT.unavailable
}

/**
 * Version-probes a binary.
 *
 * Both streams are combined because `ssh -V` writes its version to stderr:
 * reading stdout alone reports OpenSSH as missing on every machine that has it.
 */
function probe(binary: string, args: string[]): string | null {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  if (result.error) return null
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return combined === '' ? null : combined
}

function pickFetcher(): { binary: string; args: string[] } | null {
  for (const candidate of [
    { binary: 'curl', args: ['-fsSL'] },
    { binary: 'wget', args: ['-qO-'] },
  ]) {
    try {
      execFileSync('command', ['-v', candidate.binary], { stdio: 'ignore', shell: '/bin/sh' })
      return candidate
    } catch {
      // try the next one
    }
  }
  return null
}
