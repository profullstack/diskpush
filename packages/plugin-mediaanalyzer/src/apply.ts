/**
 * What an analysis does to the folder: sidecars, and (when asked) sorting.
 *
 * Two rules hold everywhere in here:
 *
 *   - Nothing of the user's is overwritten. A sidecar is only replaced when it
 *     carries our signature line, and a move never lands on an existing name:
 *     a clash becomes `name (2).jpg`.
 *   - Every sort can be undone. Each move is written to a journal under
 *     `<dir>/.mediaanalyzer/` before the next one starts, and "Undo last sort"
 *     walks it backwards, putting back exactly the tree that was there.
 */
import { link, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, posix } from 'node:path'
import { SIDECAR_SUFFIX, STATE_DIR, type Result } from './library.js'

export const SIGNATURE = 'Described by MediaAnalyzer (mediaanalyzer.pro)'

export function sidecarText(result: Pick<Result, 'description' | 'category' | 'tags'>): string {
  const lines = [result.description ?? '', '', `Folder: ${result.category ?? ''}`]
  if (result.tags.length > 0) lines.push(`Tags: ${result.tags.join(', ')}`)
  lines.push(SIGNATURE)
  return `${lines.join('\n')}\n`
}

/** The category and tags back out of a sidecar we wrote; null for one we did not. */
export function parseSidecar(text: string): { category: string | null; tags: string[] } | null {
  if (!text.includes(SIGNATURE)) return null
  const category = /^Folder: (.*)$/m.exec(text)?.[1]?.trim() || null
  const tags = /^Tags: (.*)$/m.exec(text)?.[1]?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? []
  return { category, tags }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function readOurSidecar(file: string): Promise<{ category: string | null; tags: string[] } | null> {
  const text = await readIfExists(`${file}${SIDECAR_SUFFIX}`)
  return text === null ? null : parseSidecar(text)
}

/**
 * Writes `<file>.description.txt`. Returns `kept` when a sidecar is already
 * there that we did not write: that one is the user's, and stays.
 */
export async function writeSidecar(file: string, result: Result): Promise<'written' | 'kept'> {
  const path = `${file}${SIDECAR_SUFFIX}`
  const existing = await readIfExists(path)
  if (existing !== null && !existing.includes(SIGNATURE)) return 'kept'
  await writeFile(path, sidecarText(result))
  return 'written'
}

/**
 * A folder name from a category: one path segment, nothing that climbs or
 * hides. "Pets/Dogs" is "Pets-Dogs", not a directory two deep.
 */
export function folderName(category: string | null): string {
  const cleaned = (category ?? '')
    .replace(/[\\/:*?"<>|\0-\u001f]+/g, '-')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .trim()
    .slice(0, 80)
  return cleaned || 'Uncategorized'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Moves a file without ever replacing what is at the destination.
 *
 * A hard link then an unlink is atomic about that: the link fails with EEXIST
 * if the name is taken. Filesystems without hard links (FAT and exFAT, which
 * is most memory cards) fall back to checking first and renaming.
 */
export async function moveNoClobber(from: string, to: string): Promise<void> {
  try {
    await link(from, to)
    await unlink(from)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error(`${to} already exists`)
    if (code === 'ENOENT') throw error
  }
  if (await exists(to)) throw new Error(`${to} already exists`)
  await rename(from, to)
}

export type Move = { from: string; to: string }

export type Journal = {
  version: 1
  createdAt: string
  /** Relative to the action's directory. */
  moves: Move[]
  /** Folders the sort created, removed again by undo when they are empty. */
  createdDirs: string[]
}

async function saveJournal(dir: string, name: string, journal: Journal): Promise<void> {
  await mkdir(join(dir, STATE_DIR), { recursive: true })
  await writeFile(join(dir, STATE_DIR, name), `${JSON.stringify(journal, null, 2)}\n`)
}

const abs = (dir: string, rel: string) => join(dir, ...rel.split('/'))

/** `photo.jpg`, `photo (2).jpg`, ... until the file AND its sidecar name are both free. */
async function freeName(dir: string, folder: string, name: string, taken: Set<string>): Promise<string> {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let n = 1; ; n += 1) {
    const candidate = posix.join(folder, n === 1 ? name : `${stem} (${n})${extension}`)
    if (taken.has(candidate)) continue
    if (!(await exists(abs(dir, candidate))) && !(await exists(abs(dir, `${candidate}${SIDECAR_SUFFIX}`)))) return candidate
  }
}

export type SortItem = { rel: string; category: string | null }

export type SortReport = { moved: number; alreadyInPlace: number; failed: string[]; journal: string | null }

/**
 * Moves each file, and its sidecar, into `<dir>/<category>/`.
 * Files already in their category's folder stay where they are.
 */
export async function sortIntoFolders(
  dir: string,
  items: readonly SortItem[],
  options: { signal?: AbortSignal; now?: Date; onMove?: (move: Move) => void } = {},
): Promise<SortReport> {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const journalName = `undo-${stamp}.json`
  const journal: Journal = { version: 1, createdAt: new Date().toISOString(), moves: [], createdDirs: [] }
  const taken = new Set<string>()
  const report: SortReport = { moved: 0, alreadyInPlace: 0, failed: [], journal: null }

  for (const item of items) {
    options.signal?.throwIfAborted()
    const folder = folderName(item.category)
    if (posix.dirname(item.rel) === folder) {
      report.alreadyInPlace += 1
      continue
    }
    try {
      if (!(await exists(abs(dir, folder)))) {
        await mkdir(abs(dir, folder))
        journal.createdDirs.push(folder)
      }
      const to = await freeName(dir, folder, posix.basename(item.rel), taken)
      taken.add(to)
      const moves: Move[] = [{ from: item.rel, to }]
      if (await exists(abs(dir, `${item.rel}${SIDECAR_SUFFIX}`))) {
        moves.push({ from: `${item.rel}${SIDECAR_SUFFIX}`, to: `${to}${SIDECAR_SUFFIX}` })
      }
      for (const move of moves) {
        // Journaled first: a crash between the two leaves a journal entry for
        // a move that did not happen, which undo skips, rather than a moved
        // file nothing remembers.
        journal.moves.push(move)
        await saveJournal(dir, journalName, journal)
        report.journal = join(dir, STATE_DIR, journalName)
        try {
          await moveNoClobber(abs(dir, move.from), abs(dir, move.to))
        } catch (error) {
          journal.moves.pop()
          await saveJournal(dir, journalName, journal)
          throw error
        }
        options.onMove?.(move)
      }
      report.moved += 1
    } catch (error) {
      report.failed.push(`${item.rel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (journal.moves.length === 0 && report.journal === null && journal.createdDirs.length > 0) {
    await saveJournal(dir, journalName, journal)
    report.journal = join(dir, STATE_DIR, journalName)
  }
  return report
}

export type UndoReport = { restored: number; skipped: string[]; journal: string | null }

/** Puts back the most recent sort that has not been undone. */
export async function undoLastSort(dir: string): Promise<UndoReport> {
  const folder = join(dir, STATE_DIR)
  const names = (await readdir(folder).catch(() => [] as string[]))
    .filter((name) => /^undo-.*\.json$/.test(name) && !name.endsWith('.undone.json'))
    .sort()
  const latest = names.at(-1)
  if (!latest) return { restored: 0, skipped: [], journal: null }

  const journal = JSON.parse(await readFile(join(folder, latest), 'utf8')) as Journal
  const report: UndoReport = { restored: 0, skipped: [], journal: join(folder, latest) }
  for (const move of [...journal.moves].reverse()) {
    const from = abs(dir, move.from)
    const to = abs(dir, move.to)
    if (!(await exists(to))) {
      report.skipped.push(`${move.to}: no longer there`)
      continue
    }
    if (await exists(from)) {
      report.skipped.push(`${move.from}: something is there now`)
      continue
    }
    await mkdir(dirname(from), { recursive: true })
    await moveNoClobber(to, from)
    report.restored += 1
  }
  for (const created of [...journal.createdDirs].reverse()) {
    // Only if empty: anything the user put there since stays, and so does the folder.
    await rmdir(abs(dir, created)).catch(() => {})
  }
  await rename(join(folder, latest), join(folder, latest.replace(/\.json$/, '.undone.json')))
  return report
}
