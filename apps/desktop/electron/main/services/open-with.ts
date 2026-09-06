import { execFile, spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { WebContents } from 'electron'
import { shell } from 'electron'
import { IPC } from '../../shared/contract.js'

const execFileAsync = promisify(execFile)

export type FileHandler = {
  /** The desktop entry id, e.g. `org.gnome.gedit.desktop`. */
  id: string
  name: string
  /** True for the handler the system would use on a plain double-click. */
  isDefault: boolean
  /** Runs in a terminal, so opening it from a GUI usually does nothing useful. */
  terminal: boolean
}

export type HandlerList = {
  /**
   * The content type the whole selection shares, or null when it is mixed (or
   * unreadable). Mixed is not a failure: it is the case where "one handler for
   * all of them" is the wrong question, and each file's own default is right.
   */
  contentType: string | null
  handlers: FileHandler[]
  /**
   * Why the list is empty or short, when there is a reason worth showing.
   * A dialog that offers nothing and explains nothing is a dead end.
   */
  note: string | null
}

/**
 * The `[Desktop Entry]` group of a .desktop file.
 *
 * Only that group: a file can carry `[Desktop Action new-window]` sections
 * with their own `Name=`, and reading the whole file with a naive key match
 * picks up whichever came last.
 *
 * Localised keys are skipped. `Name[it]=Monitor di sistema` is not the name to
 * show, and `Name` is not the last one in the file.
 */
export function parseDesktopEntry(text: string): {
  name: string | null
  noDisplay: boolean
  terminal: boolean
  hidden: boolean
} {
  let inEntry = false
  let name: string | null = null
  let noDisplay = false
  let terminal = false
  let hidden = false

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue

    const equals = line.indexOf('=')
    if (equals === -1) continue
    const key = line.slice(0, equals).trim()
    const value = line.slice(equals + 1).trim()

    // `Name[it]` and friends are localisations of a key, not the key.
    if (key.includes('[')) continue

    if (key === 'Name' && name === null) name = value
    else if (key === 'NoDisplay') noDisplay = value.toLowerCase() === 'true'
    else if (key === 'Terminal') terminal = value.toLowerCase() === 'true'
    else if (key === 'Hidden') hidden = value.toLowerCase() === 'true'
  }

  return { name, noDisplay, terminal, hidden }
}

/**
 * Reads `gio mime TYPE`.
 *
 * Its output looks like this, curly quotes and tabs included:
 *
 *     Default application for “text/plain”: org.gnome.gedit.desktop
 *     Registered applications:
 *     	org.gnome.gedit.desktop
 *     	vim.desktop
 *     Recommended applications:
 *     	org.gnome.gedit.desktop
 *
 * and like this when there is nothing:
 *
 *     No default applications for “text/plain”
 *
 * The default is returned first and never duplicated into the rest.
 */
export function parseGioMime(stdout: string): { defaultId: string | null; ids: string[] } {
  let defaultId: string | null = null
  const ids: string[] = []

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue

    const isDefault = /^Default application for .*:\s*(\S+)$/.exec(line)
    if (isDefault) {
      defaultId = isDefault[1] ?? null
      continue
    }
    // Section headings and the "nothing here" line carry no ids.
    if (line.endsWith(':') || line.startsWith('No default applications')) continue
    if (line.endsWith('.desktop')) ids.push(line)
  }

  const seen = new Set<string>()
  const ordered = [defaultId, ...ids].filter((id): id is string => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })

  return { defaultId, ids: ordered }
}

/** Where .desktop files live, most specific first. */
function applicationDirectories(): string[] {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [dataHome, ...dataDirs].map((directory) => join(directory, 'applications'))
}

/**
 * Resolves a desktop id to a readable file.
 *
 * The id is treated as a bare filename. A renderer supplying
 * `../../../etc/passwd.desktop` would otherwise pick the file to launch, and
 * "which program opens this" is not a decision the renderer gets to make
 * outside the installed set.
 */
async function findDesktopFile(id: string): Promise<{ path: string; text: string } | null> {
  if (id !== basename(id) || !id.endsWith('.desktop')) return null
  for (const directory of applicationDirectories()) {
    const path = join(directory, id)
    try {
      return { path, text: await readFile(path, 'utf8') }
    } catch {
      // Not in this directory; try the next.
    }
  }
  return null
}

async function contentTypeOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gio', ['info', '-a', 'standard::content-type', path])
    return /standard::content-type:\s*(\S+)/.exec(stdout)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * The applications that can open a file, with the system default marked.
 *
 * Linux only, in the sense that only Linux can enumerate them: `gio` is part
 * of glib and is what the desktop itself consults. Elsewhere the list comes
 * back empty and the dialog offers the system default alone, which is still
 * the thing most people want.
 */
export async function handlersFor(paths: readonly string[]): Promise<HandlerList> {
  if (paths.length === 0) return { contentType: null, handlers: [], note: null }

  if (process.platform !== 'linux') {
    return {
      contentType: null,
      handlers: [],
      note: 'Choosing a different application is only supported on Linux. The system default is used.',
    }
  }

  const types = new Set<string>()
  for (const path of paths) {
    const type = await contentTypeOf(path)
    if (type) types.add(type)
    // Two distinct types is already enough to know the answer.
    if (types.size > 1) break
  }

  if (types.size > 1) {
    return {
      contentType: null,
      handlers: [],
      note: `These ${paths.length} files are not all the same type, so each one opens with its own default application.`,
    }
  }

  const contentType = [...types][0] ?? null
  if (!contentType) {
    return { contentType: null, handlers: [], note: 'Could not read the file type. The system default is used.' }
  }

  let ids: string[] = []
  let defaultId: string | null = null
  try {
    const { stdout } = await execFileAsync('gio', ['mime', contentType])
    const parsed = parseGioMime(stdout)
    ids = parsed.ids
    defaultId = parsed.defaultId
  } catch {
    return { contentType, handlers: [], note: 'gio is not available, so the system default is used.' }
  }

  const handlers: FileHandler[] = []
  for (const id of ids) {
    const found = await findDesktopFile(id)
    if (!found) continue
    const entry = parseDesktopEntry(found.text)
    // NoDisplay/Hidden entries are plumbing the desktop hides from menus, and
    // this is a menu.
    if (entry.noDisplay || entry.hidden) continue
    handlers.push({
      id,
      name: entry.name ?? id.replace(/\.desktop$/, ''),
      isDefault: id === defaultId,
      terminal: entry.terminal,
    })
  }

  return {
    contentType,
    handlers,
    note:
      handlers.length === 0
        ? `Nothing is registered to open ${contentType} on this machine. The system default is used.`
        : null,
  }
}

/**
 * Opens one file and resolves when the application is finished with it.
 *
 * `gio launch` returns almost immediately: it hands the file to the desktop's
 * launcher and exits (measured at 17ms). The application it started inherits
 * this process's stdio, so the PIPES close when the application does, not when
 * gio does (measured at 3018ms for a 3 second app). Waiting on the pipes is
 * therefore the one reliable "the user is done with this file" signal that
 * does not involve reimplementing the desktop entry's Exec syntax.
 *
 * The caveat is real and handled by the caller: a single-instance application
 * hands the file to an already-running copy and exits at once, so a fast close
 * means "we cannot tell", not "they finished in half a second".
 */
function openAndWait(desktopPath: string, file: string): Promise<{ elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn('gio', ['launch', desktopPath, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let pipes = 2
    let failed: Error | null = null

    child.on('error', (error) => reject(error))
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) failed = new Error(`Could not open ${file}.`)
    })

    const closed = () => {
      pipes -= 1
      if (pipes > 0) return
      if (failed) reject(failed)
      else resolve({ elapsedMs: Date.now() - started })
    }
    child.stdout.on('end', closed).resume()
    child.stderr.on('end', closed).resume()
  })
}

/**
 * Below this, the application almost certainly handed the file to a copy that
 * was already running rather than finishing with it.
 *
 * A real hand-off is tens of milliseconds (gio itself returns in about 17).
 * Somebody actually watching or reading something takes seconds at the very
 * least. One second sits well clear of the first and nowhere near the second.
 */
const HANDOFF_MS = 1000

export type SeriesEvent =
  | { type: 'opening'; index: number; total: number; path: string }
  | { type: 'finished-one'; index: number; total: number; path: string; handedOff: boolean }
  | { type: 'done'; opened: number; total: number; stopped: boolean }
  | { type: 'error'; message: string }

type RunningSeries = {
  advance: () => void
  stop: () => void
  waiting: boolean
}

const series = new Map<string, RunningSeries>()

/**
 * Opens a list of files one after another.
 *
 * Each file waits for the previous application to finish, which is the point:
 * a series of episodes is something you watch in order, and opening all twelve
 * at once is not a thing anyone wants. When a hand-off is detected the run
 * pauses and waits to be advanced by hand instead, because auto-advancing
 * would then dump the whole list into the running player at once, which is the
 * exact failure this mode exists to avoid.
 */
export async function openSeries(
  seriesId: string,
  paths: readonly string[],
  handlerId: string | null,
  sender: WebContents,
): Promise<void> {
  const send = (event: SeriesEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC.eventOpenSeries, { seriesId, event })
  }

  let stopped = false
  let resumeManual: (() => void) | null = null
  const entry: RunningSeries = {
    advance: () => {
      const resume = resumeManual
      resumeManual = null
      entry.waiting = false
      resume?.()
    },
    stop: () => {
      stopped = true
      entry.advance()
    },
    waiting: false,
  }
  series.set(seriesId, entry)

  const found = handlerId ? await findDesktopFile(handlerId) : null
  if (handlerId && !found) {
    series.delete(seriesId)
    send({ type: 'error', message: 'That application is no longer installed.' })
    return
  }

  let opened = 0
  try {
    for (const [index, path] of paths.entries()) {
      if (stopped) break
      send({ type: 'opening', index, total: paths.length, path })

      let handedOff = false
      if (found) {
        const { elapsedMs } = await openAndWait(found.path, path)
        handedOff = elapsedMs < HANDOFF_MS
      } else {
        const error = await shell.openPath(path)
        if (error) throw new Error(error)
        // openPath never blocks, so there is nothing to wait on and every step
        // is a hand-off as far as we can tell.
        handedOff = true
      }
      opened += 1
      send({ type: 'finished-one', index, total: paths.length, path, handedOff })

      const isLast = index === paths.length - 1
      if (handedOff && !isLast && !stopped) {
        // Wait to be told, rather than guessing that they are done.
        entry.waiting = true
        await new Promise<void>((resolve) => {
          resumeManual = resolve
        })
      }
    }
    send({ type: 'done', opened, total: paths.length, stopped })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    series.delete(seriesId)
  }
}

/** Opens the next file in a series that is waiting to be advanced. */
export function advanceSeries(seriesId: string): boolean {
  const entry = series.get(seriesId)
  if (!entry?.waiting) return false
  entry.advance()
  return true
}

export function stopSeries(seriesId: string): boolean {
  const entry = series.get(seriesId)
  if (!entry) return false
  entry.stop()
  return true
}

/**
 * Opens a file, optionally with a chosen application.
 *
 * With no handler this is the plain double-click: whatever the system would
 * do. With one, that application is launched through `gio launch`, which
 * applies the desktop entry's own Exec line rather than us trying to
 * reconstruct its argument syntax.
 */
export async function openWith(paths: readonly string[], handlerId?: string | null): Promise<void> {
  if (!handlerId) {
    for (const path of paths) {
      const error = await shell.openPath(path)
      // openPath resolves with a message rather than rejecting.
      if (error) throw new Error(error)
    }
    return
  }

  const found = await findDesktopFile(handlerId)
  if (!found) throw new Error('That application is no longer installed.')
  // One invocation with every file: a desktop entry that takes %F or %U gets
  // them together, which is what "open all at once" means to the application
  // as well as to the person asking for it.
  await execFileAsync('gio', ['launch', found.path, ...paths])
}

/** Exported for the tests: the search path is environment-dependent. */
export const _internals = { applicationDirectories, findDesktopFile }
