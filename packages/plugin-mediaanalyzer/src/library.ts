/**
 * The files an action covers, and what DiskPush remembers about them.
 *
 * A selection is walked into a flat list of media files, each with a
 * `client_ref` that is stable for as long as the file is: the same formula
 * the MediaAnalyzer CLI uses (sha256 of relative path, size and mtime), so a
 * retry, a resumed run or a run from the other tool never pays twice.
 *
 * The state file lives beside the media, in `<dir>/.mediaanalyzer/`, so it
 * travels with the folder and a second machine picks up where the first left.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { EntryRef } from '@diskpush/plugin-api'
import { mediaKind, type MediaKind } from './media.js'

export const STATE_DIR = '.mediaanalyzer'
export const STATE_FILE = 'diskpush-state.json'
export const SIDECAR_SUFFIX = '.description.txt'

export type MediaFile = {
  abs: string
  /** Relative to the action's directory, with forward slashes. */
  rel: string
  name: string
  kind: MediaKind
  bytes: number
  mtimeMs: number
  ref: string
}

export function fileRef(rel: string, bytes: number, mtimeMs: number): string {
  return createHash('sha256').update(`${rel}\0${bytes}\0${Math.floor(mtimeMs)}`).digest('hex').slice(0, 32)
}

/** Skipped while walking: hidden entries, our own state, and sidecars. */
function ignored(name: string): boolean {
  return name.startsWith('.') || name === STATE_DIR || name.endsWith(SIDECAR_SUFFIX)
}

/**
 * Every media file under the selection, folders walked recursively. Symbolic
 * links are not followed: a link can point anywhere, and an action on "this
 * folder" must not read or move things outside it.
 */
export async function collectMedia(dir: string, entries: readonly EntryRef[], signal?: AbortSignal): Promise<MediaFile[]> {
  const out: MediaFile[] = []
  const visit = async (rel: string): Promise<void> => {
    signal?.throwIfAborted()
    const abs = join(dir, ...rel.split('/'))
    const stats = await lstat(abs).catch(() => null)
    if (!stats || stats.isSymbolicLink()) return
    if (stats.isDirectory()) {
      const names = (await readdir(abs).catch(() => [] as string[])).sort()
      for (const name of names) if (!ignored(name)) await visit(posix.join(rel, name))
      return
    }
    if (!stats.isFile()) return
    const name = posix.basename(rel)
    const kind = mediaKind(name)
    if (!kind || name.endsWith(SIDECAR_SUFFIX)) return
    out.push({ abs, rel, name, kind, bytes: stats.size, mtimeMs: stats.mtimeMs, ref: fileRef(rel, stats.size, stats.mtimeMs) })
  }
  for (const entry of entries) {
    // A hidden entry the user picked explicitly is still theirs to analyse.
    if (entry.name === STATE_DIR) continue
    await visit(entry.name)
  }
  return out
}

export type Result = {
  status: 'done' | 'error'
  category: string | null
  description: string | null
  tags: string[]
  error: string | null
}

export type FileState = {
  rel: string
  uploaded: boolean
  /** Why the server or DiskPush would not take it. */
  skipped?: string
  result?: Result
}

export type State = {
  version: 1
  server: string | null
  scanId: string | null
  tier: string | null
  /** `next_finished_after` from the last poll. Inclusive, so results are deduped by ref. */
  cursor: string
  files: Record<string, FileState>
}

export function blankState(): State {
  return { version: 1, server: null, scanId: null, tier: null, cursor: '', files: {} }
}

export async function loadState(dir: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, STATE_DIR, STATE_FILE), 'utf8')) as Partial<State>
    if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) return blankState()
    return { ...blankState(), ...parsed, files: parsed.files }
  } catch {
    return blankState()
  }
}

/** Written to a temporary name and renamed, so an interrupted write never leaves half a file. */
export async function saveState(dir: string, state: State): Promise<void> {
  const folder = join(dir, STATE_DIR)
  await mkdir(folder, { recursive: true })
  const path = join(folder, STATE_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporary, path)
}
