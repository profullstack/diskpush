import { describe, expect, it, vi } from 'vitest'
import type { RsyncEvent } from '@diskpush/schemas'

/**
 * A run whose events this test pushes by hand, so a scan can be inspected
 * while it is still going -- which is the whole point of what is being tested.
 */
function fakeRun() {
  const queue: RsyncEvent[] = []
  const waiters: Array<(result: IteratorResult<RsyncEvent>) => void> = []
  let done = false
  let killed = false

  const push = (event: RsyncEvent) => {
    const waiter = waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else queue.push(event)
  }
  const end = () => {
    done = true
    while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true })
  }

  return {
    push,
    end,
    get killed() {
      return killed
    },
    handle: {
      cancel: () => {
        killed = true
        // A real SIGINT makes rsync exit, which is what closes the stream.
        push({ type: 'exit', code: 20, signal: 'SIGINT', resumable: true, message: 'Interrupted.' } as RsyncEvent)
        end()
      },
      events: {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<RsyncEvent>> {
              const queued = queue.shift()
              if (queued) return Promise.resolve({ value: queued, done: false })
              if (done) return Promise.resolve({ value: undefined as never, done: true })
              return new Promise((resolve) => waiters.push(resolve))
            },
          }
        },
      },
    },
  }
}

/** A stable holder, so the mock factory reads whichever run a test installed. */
const runs = { current: fakeRun() }

vi.mock('./store.js', () => ({
  store: async () => ({ getSetting: async <T>(_key: string, fallback: T) => fallback }),
}))

vi.mock('@diskpush/rsync-core', () => ({
  planTransfer: () => ({
    binary: 'rsync',
    args: [],
    display: 'rsync --dry-run a/ b/',
    controlDisplay: null,
    warnings: [],
  }),
  runPlan: () => runs.current.handle,
  parseRsyncCapabilities: () => ({}),
  intersectCapabilities: (a: unknown) => a,
  unknownCapabilities: () => ({}),
}))

const { PREVIEW_DELETE_LIMIT, cancelPreview, previewTransfer } = await import('./transfers.js')

const REQUEST = {
  source: { type: 'local' as const, path: '/src/' },
  destination: { type: 'local' as const, path: '/dst/' },
  options: {
    archive: true,
    checksum: false,
    compression: 'auto' as const,
    deleteMode: 'delay' as const,
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

type Progress = { checked: number; total: number; changes: number; deletes: number; currentPath: string }
type Sent = { channel: string; payload: { previewId: string; progress: Progress } }

function sender() {
  const sent: Sent[] = []
  return {
    sent,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload } as Sent),
    } as never,
  }
}

const change = (action: string, path: string): RsyncEvent =>
  ({ type: 'change', change: { action, path, itemize: null, isDirectory: false, size: null } }) as RsyncEvent

/**
 * Waits for a condition rather than for a duration.
 *
 * The preview's first await is a real `rsync --version`, so a fixed sleep is a
 * race that passes on this machine and fails on a slower one.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition never held')
}

describe('previewTransfer', () => {
  /*
   * The bug: the dialog showed a bare spinner for the whole scan, because
   * nothing was reported until the dry run finished. A scan of a remote tree
   * takes minutes, so every slow preview was indistinguishable from a hang --
   * which is exactly what it was reported as.
   */
  it('streams progress while the scan is still running', async () => {
    runs.current = fakeRun()
    const target = sender()
    const pending = previewTransfer({ ...REQUEST, previewId: 'p1' }, target.webContents)

    // Reported before rsync has said anything at all.
    await until(() => target.sent.length > 0)
    expect(target.sent[0]!.channel).toBe('event:preview')

    runs.current.push({
      type: 'progress',
      progress: {
        bytesTransferred: 0,
        percent: 0,
        bytesPerSecond: 0,
        elapsedSeconds: 0,
        filesTransferred: 1,
        filesRemaining: 400,
        filesTotal: 1000,
      },
    } as RsyncEvent)
    runs.current.push(change('add', 'photos/a.jpg'))

    runs.current.push({ type: 'exit', code: 0, signal: null, resumable: false, message: 'Done.' } as RsyncEvent)
    runs.current.end()
    await pending

    const last = target.sent.at(-1)!.payload
    expect(last.previewId).toBe('p1')
    // rsync counts down, so 400 of 1000 left means 600 compared.
    expect(last.progress.checked).toBe(600)
    expect(last.progress.total).toBe(1000)
    expect(last.progress.currentPath).toBe('photos/a.jpg')
    expect(last.progress.changes).toBe(1)
  })

  /*
   * The bug: every change was accumulated and returned. An ordinary source
   * tree produces a few hundred thousand of them -- ~70MB across the IPC
   * boundary by structured clone, for a field the renderer never read, plus a
   * DOM node per delete. The counts are exact; the enumeration is not endless.
   */
  it('returns counts rather than the change list, and caps the enumerated deletes', async () => {
    runs.current = fakeRun()
    const target = sender()
    const pending = previewTransfer({ ...REQUEST, previewId: 'p2' }, target.webContents)

    const total = PREVIEW_DELETE_LIMIT + 250
    for (let index = 0; index < total; index += 1) runs.current.push(change('delete', `old/${index}.bin`))
    runs.current.push(change('add', 'new/one.bin'))
    runs.current.push({ type: 'exit', code: 0, signal: null, resumable: false, message: 'Done.' } as RsyncEvent)
    runs.current.end()

    const result = await pending
    expect(result).not.toHaveProperty('changes')
    expect(result.deleteTotal).toBe(total)
    expect(result.deletes).toHaveLength(PREVIEW_DELETE_LIMIT)
    expect(result.changeTotal).toBe(total + 1)
    expect(result.summary.delete).toBe(total)
    expect(result.summary.add).toBe(1)
    expect(result.ok).toBe(true)
  })

  /*
   * The bug: closing the dialog only hid it. The dry run carried on to the end
   * with no way to stop it, then resolved into a window nobody was looking at.
   */
  it('cancels a running scan, and never reports a stopped scan as a usable result', async () => {
    runs.current = fakeRun()
    const target = sender()
    const pending = previewTransfer({ ...REQUEST, previewId: 'p3' }, target.webContents)

    await until(() => target.sent.length > 0)
    runs.current.push(change('delete', 'old/one.bin'))

    await until(() => cancelPreview('p3'))
    const result = await pending

    expect(runs.current.killed).toBe(true)
    expect(result.cancelled).toBe(true)
    // `ok` gates the confirm button. A scan that was stopped has not
    // established that anything is safe to delete.
    expect(result.ok).toBe(false)
    // The registration is gone, so a late Cancel cannot kill an unrelated run.
    expect(cancelPreview('p3')).toBe(false)
  })
})
