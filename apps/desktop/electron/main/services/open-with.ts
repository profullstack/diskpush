import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { shell } from 'electron'

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
  /** The file's content type, for the dialog to show. Null when it could not be read. */
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
export async function handlersFor(path: string): Promise<HandlerList> {
  if (process.platform !== 'linux') {
    return {
      contentType: null,
      handlers: [],
      note: 'Choosing a different application is only supported on Linux. The system default is used.',
    }
  }

  const contentType = await contentTypeOf(path)
  if (!contentType) {
    return { contentType: null, handlers: [], note: 'Could not read this file’s type. The system default is used.' }
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
 * Opens a file, optionally with a chosen application.
 *
 * With no handler this is the plain double-click: whatever the system would
 * do. With one, that application is launched through `gio launch`, which
 * applies the desktop entry's own Exec line rather than us trying to
 * reconstruct its argument syntax.
 */
export async function openWith(path: string, handlerId?: string | null): Promise<void> {
  if (!handlerId) {
    const error = await shell.openPath(path)
    // openPath resolves with a message rather than rejecting.
    if (error) throw new Error(error)
    return
  }

  const found = await findDesktopFile(handlerId)
  if (!found) throw new Error('That application is no longer installed.')
  await execFileAsync('gio', ['launch', found.path, path])
}

/** Exported for the tests: the search path is environment-dependent. */
export const _internals = { applicationDirectories, findDesktopFile }
