import { describe, expect, it } from 'vitest'
import { SftpBrowser } from './browser.js'

const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

type Row = { filename: string; mode: number }

/**
 * The slice of ssh2's SFTPWrapper the browser actually uses.
 *
 * `readdir` reports a link the way lstat does; `stat` follows it. Keeping both
 * in a stub is the whole point — that difference is the bug being tested.
 */
function fakeSftp(rows: Row[], targets: Record<string, number | 'error'>) {
  return {
    readdir(_directory: string, callback: (error: Error | null, entries: unknown[]) => void) {
      callback(
        null,
        rows.map((row) => ({
          filename: row.filename,
          attrs: { mode: row.mode, size: 4, mtime: 0, uid: 1000, gid: 1000 },
        })),
      )
    },
    stat(path: string, callback: (error: Error | null, stats?: unknown) => void) {
      const target = targets[path]
      if (target === undefined || target === 'error') {
        callback(new Error('No such file'))
        return
      }
      callback(null, { mode: target, size: 4, mtime: 0, uid: 1000, gid: 1000 })
    },
    readlink(path: string, callback: (error: Error | null, target?: string) => void) {
      const known: Record<string, string> = { '/home/you/data': '/mnt/vdb', '/home/you/gone': '/mnt/missing' }
      const target = known[path]
      target ? callback(null, target) : callback(new Error('not a link'))
    },
  } as never
}

describe('SftpBrowser.list', () => {
  it('resolves what a symlink points at, so a link to a directory can be opened', async () => {
    const browser = new SftpBrowser(
      fakeSftp(
        [
          { filename: 'notes.md', mode: S_IFREG | 0o644 },
          { filename: 'data', mode: S_IFLNK | 0o777 },
        ],
        { '/home/you/data': S_IFDIR | 0o755 },
      ),
    )

    const entries = await browser.list('/home/you')
    const data = entries.find((entry) => entry.name === 'data')
    expect(data?.type).toBe('symlink')
    expect(data?.targetType).toBe('directory')
    expect(data?.linkTarget).toBe('/mnt/vdb')
  })

  it('marks a link to a file as a file target, which stays unopenable', async () => {
    const browser = new SftpBrowser(
      fakeSftp([{ filename: 'conf', mode: S_IFLNK | 0o777 }], { '/home/you/conf': S_IFREG | 0o644 }),
    )
    expect((await browser.list('/home/you'))[0]?.targetType).toBe('file')
  })

  it('leaves targetType absent on a broken link rather than failing the listing', async () => {
    // A directory containing one dead link must still list; the row is simply
    // one that cannot be walked into.
    const browser = new SftpBrowser(fakeSftp([{ filename: 'gone', mode: S_IFLNK | 0o777 }], {}))
    const entries = await browser.list('/home/you')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.targetType).toBeUndefined()
  })

  it('does not stat anything for a listing with no links', async () => {
    const browser = new SftpBrowser(
      fakeSftp(
        [
          { filename: 'a', mode: S_IFREG | 0o644 },
          { filename: 'b', mode: S_IFDIR | 0o755 },
        ],
        {},
      ),
    )
    const entries = await browser.list('/home/you')
    expect(entries.map((entry) => entry.type)).toEqual(['file', 'directory'])
  })
})
