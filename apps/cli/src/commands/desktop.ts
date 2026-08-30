import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../exit-codes.js'
import { failure, type Output } from '../output.js'
import { hasFlag, type ParsedArgv } from '../parse-argv.js'
import { readManifest, stateDirectory } from './self.js'

/**
 * Launches the desktop app.
 *
 * The manifest says how DiskPush was installed, which is what decides where
 * the app lives. Everything after that is a fallback for installs the manifest
 * does not describe: a .deb, or a copy someone put in /opt by hand.
 */
function candidates(): string[] {
  const manifest = readManifest()
  const share = stateDirectory()
  const paths: string[] = []

  if (manifest?.method === 'linux-app') {
    // The launcher, not the binary: it decides the sandbox question first.
    paths.push(join(share, 'app', 'launch.sh'), join(share, 'app', 'diskpush-desktop'))
  }
  if (manifest?.method === 'macos-app') {
    paths.push(join(homedir(), 'Applications', 'DiskPush.app', 'Contents', 'MacOS', 'diskpush-desktop'))
  }

  paths.push(
    join(share, 'app', 'launch.sh'),
    join(share, 'app', 'diskpush-desktop'),
    '/usr/bin/diskpush-desktop',
    '/opt/DiskPush/diskpush-desktop',
    join(homedir(), 'Applications', 'DiskPush.app', 'Contents', 'MacOS', 'diskpush-desktop'),
    '/Applications/DiskPush.app/Contents/MacOS/diskpush-desktop',
  )
  return paths
}

export async function runDesktop(parsed: ParsedArgv, output: Output): Promise<number> {
  const found = candidates().find((path) => existsSync(path))

  if (!found) {
    return failure(
      output,
      'The DiskPush desktop app is not installed.\n' +
        'Install it with:  curl -fsSL https://diskpush.com/install.sh | sh -s -- --desktop',
      EXIT.configuration,
    )
  }

  // Detached by default: the terminal that launched a GUI should come back,
  // and closing it should not take the window with it.
  const attach = hasFlag(parsed, '--wait')
  const child = spawn(found, parsed.positionals, {
    detached: !attach,
    stdio: attach ? 'inherit' : 'ignore',
    env: desktopEnv(),
  })

  if (!attach) {
    child.unref()
    output.line(`Launched ${found}`)
    return EXIT.ok
  }

  return new Promise((resolve) => {
    child.on('error', () => resolve(EXIT.unavailable))
    child.on('close', (code) => resolve(code ?? EXIT.ok))
  })
}

/**
 * The environment for the desktop app.
 *
 * `ELECTRON_RUN_AS_NODE` has to be removed. A desktop install runs the CLI on
 * the Node inside Electron, so the shim sets that variable — and a plain
 * `spawn` inherits it, which makes the app start as a Node process and exit
 * immediately instead of opening a window. The symptom is the worst kind:
 * `diskpush desktop` reports that it launched, and nothing appears, while
 * running the very same launcher from a shell works.
 */
export function desktopEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}
