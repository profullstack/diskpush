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

  list(directory: string): Promise<RemoteEntry[]> {
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
