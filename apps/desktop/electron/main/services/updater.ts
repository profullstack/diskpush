import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'

/**
 * Startup update check.
 *
 * It shells out to the same installer the CLI uses rather than embedding
 * electron-updater: the installer already knows every way DiskPush can be
 * installed, and electron-updater only handles AppImage on Linux, which is not
 * the layout the installer produces.
 */

const RELEASES_API = 'https://api.github.com/repos/profullstack/diskpush/releases/latest'

type Manifest = { version: string; method: string; installer: string; desktop: boolean }

function manifestPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(process.env.DISKPUSH_HOME ? join(process.env.DISKPUSH_HOME, 'install') : join(dataHome, 'diskpush'), 'manifest.json')
}

function readManifest(): Manifest | null {
  const path = manifestPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** Numeric comparison, so 0.10.0 is newer than 0.9.0. */
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

async function latestVersion(): Promise<string | null> {
  try {
    const response = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `diskpush/${app.getVersion()}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) return null
    const release = (await response.json()) as { tag_name?: string; draft?: boolean }
    if (!release.tag_name || release.draft) return null
    return release.tag_name.replace(/^v/, '')
  } catch {
    return null
  }
}

function runInstaller(installer: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `curl -fsSL ${installer} | sh`], { stdio: 'ignore', detached: false })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/**
 * @param hasActiveTransfer tells the updater whether restarting right now
 *   would interrupt work. It applies the update either way, but a file
 *   transfer is exactly the thing not to kill for a version bump.
 */
export async function checkForUpdates(hasActiveTransfer: () => boolean): Promise<void> {
  if (process.env.DISKPUSH_NO_AUTO_UPDATE) return

  const manifest = readManifest()
  // Installed some other way (a .deb, a distro package, a source checkout):
  // whatever installed it is what should update it.
  if (!manifest || manifest.method === 'source') return

  const latest = await latestVersion()
  if (!latest || !isNewer(latest, app.getVersion())) return

  const installed = await runInstaller(manifest.installer)
  if (!installed) return

  // The new version is on disk; only the running process is stale. Restarting
  // mid-transfer would abandon it, so that waits.
  if (hasActiveTransfer()) return

  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'info' as const,
    buttons: ['Later', 'Restart now'],
    defaultId: 1,
    cancelId: 0,
    title: 'Update installed',
    message: `DiskPush ${latest} has been installed.`,
    detail: 'Restart to use it. Your connections, profiles and queued jobs are unaffected.',
  }

  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  if (result.response === 1) {
    app.relaunch()
    app.exit(0)
  }
}
