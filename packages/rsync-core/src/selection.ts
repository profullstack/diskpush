import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Transferring only the entries someone picked, rather than a whole directory.
 *
 * The selection is a list of names relative to the source directory, and it
 * reaches rsync as a `--files-from` list rather than as extra source
 * arguments. Both work; the list wins on two counts. It is not bounded by the
 * command-line length limit, so selecting four hundred files is the same shape
 * as selecting one. And with `--from0` it can express every name a filesystem
 * allows, including the ones with a newline in them, which no argument list
 * assembled from a newline-separated source can.
 *
 * Two behaviours of `--files-from` are worth knowing, both verified against
 * rsync 3.4.1 rather than taken from the manual:
 *
 *  - It turns recursion **off**, and `--archive` does not turn it back on. A
 *    selected folder arrives as an empty directory unless `--recursive` is
 *    restated. `buildRsyncArgs` restates it.
 *  - `--delete` stays scoped to the listed entries. Mirroring a selection
 *    removes destination files inside those entries and leaves the rest of the
 *    destination alone, which is the behaviour you would want and not the one
 *    you would fear.
 */

export class SelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionError'
  }
}

/**
 * Rejects anything that is not a plain entry name inside the source directory.
 *
 * A selection comes from a file listing, so a name is all it should ever be.
 * `..` would reach outside the directory being transferred, and an absolute
 * path would ignore it entirely — neither is a thing a selection can mean.
 */
export function assertSelectable(name: string): void {
  if (name.length === 0) throw new SelectionError('An empty name cannot be selected.')
  if (name.startsWith('/')) throw new SelectionError(`A selection must be relative to the source: ${JSON.stringify(name)}.`)
  if (name.includes('\0')) throw new SelectionError('A name cannot contain a NUL byte.')
  const segments = name.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new SelectionError(`A selection cannot climb out of the source directory: ${JSON.stringify(name)}.`)
  }
  if (segments.some((segment) => segment === '.' || segment === '')) {
    throw new SelectionError(`${JSON.stringify(name)} is not a usable entry name.`)
  }
}

export type SelectionList = {
  /** Path to the NUL-separated list, for `--files-from`. */
  path: string
  /** Removes the list and its directory. Safe to call more than once. */
  cleanup: () => void
}

/**
 * Writes a selection to a NUL-separated list file in a private temp directory.
 *
 * The caller removes it with `cleanup()` once rsync has exited — rsync reads
 * the list at startup, but deleting it out from under a run that has not begun
 * would be a race, so it is not tied to anything cleverer than the caller's
 * `finally`.
 */
export function writeSelectionList(names: readonly string[]): SelectionList {
  if (names.length === 0) throw new SelectionError('Nothing was selected.')
  for (const name of names) assertSelectable(name)

  const directory = mkdtempSync(join(tmpdir(), 'diskpush-selection-'))
  const path = join(directory, 'files-from')
  // NUL-separated, with a trailing NUL: `--from0` reads it as a list of
  // NUL-terminated names.
  writeFileSync(path, `${names.join('\0')}\0`, { mode: 0o600 })

  let removed = false
  return {
    path,
    cleanup: () => {
      if (removed) return
      removed = true
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // A temp file that outlives the run is untidy, not a failure of the
        // transfer, and the transfer's outcome is what the caller reports.
      }
    },
  }
}

/** One line describing the selection, for a preview or a summary. */
export function describeSelection(names: readonly string[]): string {
  if (names.length === 1) return names[0]!
  return `${names.length} selected entries`
}
