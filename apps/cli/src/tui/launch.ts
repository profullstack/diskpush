/**
 * Handing a file to something that is not the viewer.
 *
 * The viewer shows what it can. For the rest — a file you want to change, a
 * video, an image, an archive — the answer is the program the system already
 * has for it: `$EDITOR` for editing, and a player or the desktop opener for
 * the media types. Under tmux that program gets a window of its own and the
 * browser keeps running beside it; without tmux the browser hands the
 * terminal over and comes back when the program exits, the way vim's `:sh`
 * does. Modelled on moshcode's `/shell` and `/new`.
 *
 * The planning is pure and tested; the two effects at the bottom are thin.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, extname, join } from 'node:path'
import { shellJoin, shellQuote } from '@diskpush/rsync-core'
import type { Connection } from '@diskpush/schemas'

/** A program to run, and where. */
export type Launch = {
  argv: string[]
  cwd?: string
  /** What to call the tmux window. */
  title: string
  /**
   * Returns at once and owns no terminal: a desktop opener. It is spawned
   * detached rather than given a window that would close immediately.
   */
  detached?: boolean
}

/** Whether a program is on PATH. */
export type Available = (bin: string) => boolean

export function onPath(env: NodeJS.ProcessEnv = process.env): Available {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  return (bin) => bin.includes('/') ? existsSync(bin) : dirs.some((dir) => existsSync(join(dir, bin)))
}

/** Editors tried, in order, when neither $VISUAL nor $EDITOR is set. */
const EDITORS = ['vim', 'nvim', 'nano', 'vi']

/**
 * The editor as argv: `$VISUAL`, then `$EDITOR`, then the first of the usual
 * suspects on PATH. Split on whitespace because `EDITOR="code -w"` is how a
 * GUI editor is told to wait, and that flag is part of the editor.
 */
export function editorArgv(env: NodeJS.ProcessEnv, available: Available): string[] | null {
  for (const name of ['VISUAL', 'EDITOR']) {
    const value = env[name]?.trim()
    if (value) return value.split(/\s+/)
  }
  const found = EDITORS.find(available)
  return found ? [found] : null
}

/** Where a file to edit lives: on this machine, or on a server. */
export type Target = { path: string; name: string; connection: Connection | null }

/**
 * Editing a file.
 *
 * A local file goes straight to the editor. A remote one is edited *on the
 * server*, over `ssh -t`, with whatever `$VISUAL`/`$EDITOR` is there and `vi`
 * failing that — the variables are left for the remote shell to expand, which
 * is why the command is one string rather than argv. Nothing is downloaded and
 * nothing has to be uploaded back, and the file the editor saves is the file.
 */
export function editLaunch(target: Target, env: NodeJS.ProcessEnv, available: Available): Launch | { error: string } {
  if (target.connection) {
    const c = target.connection
    const argv = [
      'ssh',
      '-t',
      ...(c.port !== 22 ? ['-p', String(c.port)] : []),
      ...(c.keyPath ? ['-i', c.keyPath] : []),
      ...(c.jumpHost ? ['-J', c.jumpHost] : []),
      `${c.username}@${c.host}`,
      `\${VISUAL:-\${EDITOR:-vi}} ${shellQuote(target.path)}`,
    ]
    return { argv, title: target.name }
  }
  const editor = editorArgv(env, available)
  if (!editor) return { error: 'No editor: set $EDITOR, or install vim or nano.' }
  return { argv: [...editor, target.path], cwd: dirname(target.path), title: target.name }
}

const VIDEO = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv'])
const AUDIO = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff'])
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.heic', '.tiff', '.tif'])

export type MediaKind = 'video' | 'audio' | 'image' | 'other'

export function mediaKind(name: string): MediaKind {
  const ext = extname(name).toLowerCase()
  if (VIDEO.has(ext)) return 'video'
  if (AUDIO.has(ext)) return 'audio'
  if (IMAGE.has(ext)) return 'image'
  return 'other'
}

/** Terminal programs for each kind, in order of preference. */
const PLAYERS = ['mpv', 'ffplay', 'vlc', 'mplayer']
const AUDIO_PLAYERS = ['mpv', 'ffplay', 'play', 'mplayer']
const IMAGE_VIEWERS = ['chafa', 'timg', 'viu', 'feh']

/** True when there is a desktop to open things on. */
export function hasDesktop(env: NodeJS.ProcessEnv, platform = process.platform): boolean {
  if (platform === 'darwin') return true
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

/**
 * Opening a file with "whatever opens this".
 *
 * With a desktop in reach the desktop opener decides, exactly as a double
 * click would. On a server, or in an ssh session, there is no desktop, so a
 * video or a song goes to a player and an image to a viewer that draws in the
 * terminal — each in its own tmux window. What is left has no program to go
 * to, and the message says what would.
 *
 * `text` is what the file's own bytes say, and it outranks the name: `.ts` is
 * TypeScript a thousand times for every MPEG transport stream, and a player
 * handed a source file is a window that opens and closes with an error.
 */
export function openLaunch(
  target: Target,
  env: NodeJS.ProcessEnv,
  available: Available,
  platform = process.platform,
  { text = false }: { text?: boolean } = {},
): Launch | { error: string } {
  if (target.connection) {
    return { error: `x opens files on this machine. Sync ${target.name} here first, or press e to edit it over ssh.` }
  }
  const kind = text ? 'other' : mediaKind(target.name)
  if (hasDesktop(env, platform)) {
    const opener = platform === 'darwin' ? 'open' : 'xdg-open'
    if (available(opener)) return { argv: [opener, target.path], title: target.name, detached: true }
  }
  if (text) return { error: `${target.name} is a text file: v views it, e edits it.` }
  const candidates = kind === 'video' ? PLAYERS : kind === 'audio' ? AUDIO_PLAYERS : kind === 'image' ? IMAGE_VIEWERS : []
  const found = candidates.find(available)
  if (found) {
    // ffplay draws a window it cannot have here; ask it to play sound only.
    const argv = found === 'ffplay' && kind === 'audio' ? ['ffplay', '-nodisp', '-autoexit', target.path] : [found, target.path]
    return { argv, cwd: dirname(target.path), title: target.name }
  }
  if (kind === 'other') return { error: `Nothing here opens ${target.name}. Press e to open it in $EDITOR.` }
  return { error: `No ${kind} ${kind === 'image' ? 'viewer' : 'player'} found: install ${candidates.slice(0, 2).join(' or ')}.` }
}

/** Runs `launch` in a new tmux window beside this one. Rejects when tmux refuses. */
export function openTmuxWindow(launch: Launch, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = ['new-window', '-n', launch.title, ...(launch.cwd ? ['-c', launch.cwd] : []), shellJoin(launch.argv)]
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tmux exited ${code}`))))
  })
}

/** Starts a desktop opener and forgets it: it returns at once and owns no terminal. */
export function spawnDetached(launch: Launch, env: NodeJS.ProcessEnv = process.env): void {
  const [bin, ...args] = launch.argv
  const child = spawn(bin!, args, { env, detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * Runs `launch` with the terminal handed over, and resolves when it exits.
 *
 * Only for a terminal the TUI has already given up: the app must be stopped
 * before this, and started again after, or the two fight over the screen.
 */
export function runInherited(launch: Launch, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const [bin, ...args] = launch.argv
  return new Promise((resolve, reject) => {
    const child = spawn(bin!, args, { env, stdio: 'inherit', ...(launch.cwd ? { cwd: launch.cwd } : {}) })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}

/**
 * What the app uses to get a program on screen. Injected so a test can watch
 * what would have been launched instead of launching it.
 */
export type Launcher = {
  env: NodeJS.ProcessEnv
  available: Available
  /** True under tmux, where a program can have a window of its own. */
  inTmux: boolean
  tmux: (launch: Launch) => Promise<void>
  detach: (launch: Launch) => void
}

export function systemLauncher(env: NodeJS.ProcessEnv = process.env): Launcher {
  return {
    env,
    available: onPath(env),
    inTmux: Boolean(env.TMUX),
    tmux: (launch) => openTmuxWindow(launch, env),
    detach: (launch) => spawnDetached(launch, env),
  }
}
