import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { RsyncEvent } from '@diskpush/schemas'
import { TransferRequestSchema } from '../../shared/contract.js'

/** A run that ends immediately; these tests are about the plan, not the stream. */
function emptyRun() {
  return {
    cancel: () => {},
    events: {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ value: undefined as never, done: true as const }) }
      },
    },
  }
}

const planned: Array<{ options: { filesFrom?: string | null; from0?: boolean }; list: string | null }> = []

vi.mock('./store.js', () => ({
  store: async () => ({ getSetting: async <T>(_key: string, fallback: T) => fallback }),
}))

vi.mock('@diskpush/rsync-core', () => ({
  planTransfer: (input: { options: { filesFrom?: string | null; from0?: boolean } }) => {
    // Read here rather than from the test body: this runs while the transfer
    // still owns the file, so there is no window to race against its cleanup.
    const path = input.options.filesFrom
    planned.push({ options: input.options, list: path ? readFileSync(path, 'utf8') : null })
    return { binary: 'rsync', args: [], display: 'rsync', controlDisplay: null, warnings: [] }
  },
  runPlan: () => emptyRun(),
  parseRsyncCapabilities: () => ({}),
  intersectCapabilities: (a: unknown) => a,
  unknownCapabilities: () => ({}),
}))

const { previewTransfer } = await import('./transfers.js')

const BASE = {
  source: { type: 'local' as const, path: '/src/' },
  destination: { type: 'local' as const, path: '/dst/' },
  options: {
    archive: true,
    checksum: false,
    compression: 'auto' as const,
    deleteMode: 'off' as const,
    hardLinks: false,
    acls: false,
    xattrs: false,
    numericIds: false,
    update: false,
    ignoreExisting: false,
    existingOnly: false,
    inplace: false,
    excludes: [],
    includes: [],
    bwlimit: null,
    maxSize: null,
    minSize: null,
  },
  deletesConfirmed: false,
}

const sender = () => ({ isDestroyed: () => false, send: () => {} }) as never

describe('a selection reaches rsync', () => {
  /*
   * The bug: the panes let you select entries and the request only ever
   * carried the directory, so ticking two folders and pressing Sync copied the
   * whole tree. Two movies became forty thousand files.
   */
  it('turns picked entries into a NUL-separated --files-from list', async () => {
    planned.length = 0
    await previewTransfer(
      { ...BASE, selection: ['The Movie (2019)', 'Another Movie'], previewId: 's1' },
      sender(),
    )

    const options = planned.at(-1)!.options
    expect(options.from0).toBe(true)
    expect(options.filesFrom).toBeTruthy()
  })

  it('writes the names verbatim, separated by NUL', async () => {
    planned.length = 0
    await previewTransfer({ ...BASE, selection: ['a b.mkv', 'weird\tname'], previewId: 's2' }, sender())

    expect(planned.at(-1)!.list).toBe('a b.mkv\0weird\tname\0')
  })

  it('leaves an unselected transfer alone, so the whole folder still syncs', async () => {
    planned.length = 0
    await previewTransfer({ ...BASE, selection: [], previewId: 's3' }, sender())

    const options = planned.at(-1)!.options
    expect(options.filesFrom).toBeFalsy()
    expect(options.from0).toBeFalsy()
  })

  it('removes the list file when the run is over', async () => {
    planned.length = 0
    await previewTransfer({ ...BASE, selection: ['one'], previewId: 's4' }, sender())

    const path = planned.at(-1)!.options.filesFrom
    expect(path).toBeTruthy()
    expect(existsSync(path!)).toBe(false)
  })
})

describe('the selection is names, never paths', () => {
  /*
   * This list becomes an rsync --files-from rooted at the source directory, so
   * a renderer that could put a separator or `..` in here would be choosing
   * which files leave the machine. The schema is the only thing standing
   * between those two facts.
   */
  const reject = (selection: string[]) =>
    TransferRequestSchema.safeParse({ ...BASE, selection }).success

  it('rejects anything that could climb out of the directory', () => {
    expect(reject(['../../etc/shadow'])).toBe(false)
    expect(reject(['..'])).toBe(false)
    expect(reject(['sub/dir'])).toBe(false)
    expect(reject(['back\\slash'])).toBe(false)
    expect(reject(['nul\0byte'])).toBe(false)
    expect(reject(['/etc/passwd'])).toBe(false)
  })

  it('accepts ordinary names, spaces and all', () => {
    expect(reject(['The Movie (2019).mkv', 'Another.Movie.2020'])).toBe(true)
  })

  it('defaults to the whole folder when the field is absent', () => {
    const parsed = TransferRequestSchema.parse({
      source: BASE.source,
      destination: BASE.destination,
      options: BASE.options,
    })
    expect(parsed.selection).toEqual([])
  })
})
