/**
 * How `diskpush update` and the background auto-update download the installer.
 *
 * Found by reading PATH, not by asking a shell (`command -v` through `sh` is
 * what Node's DEP0190 warns about), and run with an argument array, so the
 * installer URL is never parsed by a shell either.
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export type Fetcher = { binary: string; args: string[] }

const CANDIDATES: Fetcher[] = [
  { binary: 'curl', args: ['-fsSL'] },
  { binary: 'wget', args: ['-qO-'] },
]

/** The full path of an executable on PATH, or null. */
export function onPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, binary + extension)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

/** curl, else wget, as the documented install line uses them. */
export function pickFetcher(env: NodeJS.ProcessEnv = process.env): Fetcher | null {
  for (const candidate of CANDIDATES) {
    const path = onPath(candidate.binary, env)
    if (path) return { binary: path, args: candidate.args }
  }
  return null
}
