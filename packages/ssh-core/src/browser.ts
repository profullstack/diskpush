import { posix } from 'node:path'
import type { FileEntry, SFTPWrapper } from 'ssh2'
import type { SshSession } from './session.js'
import { shellQuote } from '@diskpush/rsync-core'

/**
 * SFTP browsing.
 *
 * Deliberately separate from the transfer engine: rsync can list files with
 * `--list-only`, but it cannot rename, chmod or delete, and it re-establishes
 * a session per call. Browsing is SFTP; moving bytes is rsync.
 */

export type RemoteEntry = {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: string
  mode: number
  uid: number
  gid: number
  /** Present for symlinks once resolved. */
  linkTarget?: string
  /**
   * What a symlink points at, when it could be resolved.
   *
   * SFTP's readdir reports link types the way lstat does, so a link to a
   * directory arrives as `symlink` and nothing downstream can tell whether it
   * can be opened. Undefined means the target could not be stat'd — a broken
   * link, or one pointing somewhere this user cannot read.
   */
  targetType?: RemoteEntry['type']
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

/**
 * Derived from the mode bits rather than from ssh2's helper methods: the
 * objects `readdir` yields are typed as plain attributes and do not carry
 * `isDirectory()` and friends.
 */
function entryType(mode: number): RemoteEntry['type'] {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'directory'
    case S_IFLNK:
      return 'symlink'
    case S_IFREG:
      return 'file'
    default:
      return 'other'
  }
}

export class SftpBrowser {
  constructor(private readonly sftp: SFTPWrapper) {}

  static async open(session: SshSession): Promise<SftpBrowser> {
    return new SftpBrowser(await session.sftp())
  }

  async list(directory: string): Promise<RemoteEntry[]> {
    const entries = await this.readdir(directory)

    // One follow-stat per symlink, and only per symlink: a listing is mostly
    // ordinary files, and without this a link to a directory is a row nothing
    // can open.
    await Promise.all(
      entries
        .filter((entry) => entry.type === 'symlink')
        .map(async (entry) => {
          try {
            const [target, resolved] = await Promise.all([
              this.readlink(entry.path).catch(() => undefined),
              this.statFollowing(entry.path),
            ])
            entry.targetType = resolved
            if (target) entry.linkTarget = target
          } catch {
            // A broken link is still a row worth showing; it just cannot be
            // opened, which is exactly what an absent targetType means.
          }
        }),
    )
    return entries
  }

  private readdir(directory: string): Promise<RemoteEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(directory, (error, entries: FileEntry[]) => {
        if (error) {
          reject(error)
          return
        }
        resolve(
          entries.map((entry) => ({
            name: entry.filename,
            path: posix.join(directory, entry.filename),
            type: entryType(entry.attrs.mode),
            size: entry.attrs.size,
            modifiedAt: new Date(entry.attrs.mtime * 1000).toISOString(),
            mode: entry.attrs.mode & 0o7777,
            uid: entry.attrs.uid,
            gid: entry.attrs.gid,
          })),
        )
      })
    })
  }

  /** `stat`, which follows a link, where `stat()` above uses `lstat`, which does not. */
  private statFollowing(path: string): Promise<RemoteEntry['type'] | undefined> {
    return new Promise((resolve) => {
      this.sftp.stat(path, (error, stats) => resolve(error ? undefined : entryType(stats.mode)))
    })
  }

  stat(path: string): Promise<RemoteEntry> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (error, stats) => {
        if (error) {
          reject(error)
          return
        }
        resolve({
          name: posix.basename(path),
          path,
          type: entryType(stats.mode),
          size: stats.size,
          modifiedAt: new Date(stats.mtime * 1000).toISOString(),
          mode: stats.mode & 0o7777,
          uid: stats.uid,
          gid: stats.gid,
        })
      })
    })
  }

  realpath(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved)))
    })
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.readlink(path, (error, target) => (error ? reject(error) : resolve(target)))
    })
  }

  mkdir(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.mkdir(path, (error) => (error ? reject(error) : resolve()))
    })
  }

  rename(from: string, to: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(from, to, (error) => (error ? reject(error) : resolve()))
    })
  }

  unlink(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(path, (error) => (error ? reject(error) : resolve()))
    })
  }

  rmdir(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rmdir(path, (error) => (error ? reject(error) : resolve()))
    })
  }

  chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(path, mode, (error) => (error ? reject(error) : resolve()))
    })
  }

  /**
   * Creates an empty file, refusing to touch one that already exists.
   *
   * `wx` rather than `w`: "New file" in a file manager must never be a way to
   * silently truncate something that is already there.
   */
  createFile(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.open(path, 'wx', (error, handle) => {
        if (error) {
          reject(error)
          return
        }
        this.sftp.close(handle, (closeError) => (closeError ? reject(closeError) : resolve()))
      })
    })
  }

  /**
   * The first `limit` bytes of a file, and how big the whole file is.
   *
   * Not ssh2's `readFile`: that pulls the entire file into memory, and the
   * viewer is pointed at whatever sits under the cursor, which is as likely
   * to be a 40 GB backup as a README. A short read is normal here — the
   * server answers one request with however much it feels like, so the loop
   * runs until it has what it asked for or the file ran out.
   */
  async readHead(path: string, limit: number): Promise<{ bytes: Buffer; size: number }> {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.open(path, 'r', (error, opened) => (error ? reject(error) : resolve(opened)))
    })
    try {
      const size = await new Promise<number>((resolve, reject) => {
        this.sftp.fstat(handle, (error, stats) => (error ? reject(error) : resolve(stats.size)))
      })
      const bytes = Buffer.alloc(Math.max(0, Math.min(size, limit)))
      let read = 0
      while (read < bytes.length) {
        const count = await new Promise<number>((resolve, reject) => {
          this.sftp.read(handle, bytes, read, bytes.length - read, read, (error, got) =>
            error ? reject(error) : resolve(got),
          )
        })
        if (count === 0) break
        read += count
      }
      return { bytes: bytes.subarray(0, read), size }
    } finally {
      await new Promise<void>((resolve) => this.sftp.close(handle, () => resolve()))
    }
  }

  /**
   * Removes a directory and everything under it.
   *
   * SFTP's rmdir only unlinks an empty directory, so deleting a populated one
   * means walking it here. Depth first, and symlinks are unlinked rather than
   * followed — recursing through a link would delete somewhere else entirely.
   */
  async removeRecursive(path: string): Promise<void> {
    const entries = await this.list(path)
    for (const entry of entries) {
      if (entry.type === 'directory') await this.removeRecursive(entry.path)
      else await this.unlink(entry.path)
    }
    await this.rmdir(path)
  }

  close(): void {
    this.sftp.end()
  }
}

/**
 * Free space, via `df`. SFTP has a statvfs extension but it is not universally
 * implemented, and this is only ever informational.
 */
export async function remoteFreeSpace(
  session: SshSession,
  path: string,
): Promise<{ totalBytes: number; freeBytes: number } | null> {
  const result = await session.exec(`df -kP ${shellQuote(path)}`)
  if (result.code !== 0) return null

  const line = result.stdout.trim().split('\n').at(-1)
  if (!line) return null
  const columns = line.trim().split(/\s+/)
  const total = Number(columns[1])
  const available = Number(columns[3])
  if (!Number.isFinite(total) || !Number.isFinite(available)) return null
  return { totalBytes: total * 1024, freeBytes: available * 1024 }
}
