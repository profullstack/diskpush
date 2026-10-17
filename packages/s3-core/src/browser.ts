/**
 * Browsing a bucket as if it were a filesystem.
 *
 * The same method set, and the same entry shape, as ssh-core's SftpBrowser,
 * so a pane can hold either. S3 has no directories: a "directory" is a key
 * prefix ending in `/` (listed with a `/` delimiter), and an empty one is a
 * zero-byte `name/` marker object, which is what every S3 console creates.
 * Paths are absolute POSIX paths; `/photos/2024` is the prefix `photos/2024/`.
 */
import { posix } from 'node:path'
import { S3Client, S3Error } from './client.js'

/** Structurally identical to ssh-core's RemoteEntry. */
export type S3Entry = {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: string
  mode: number
  uid: number
  gid: number
  linkTarget?: string
  targetType?: S3Entry['type']
}

/** Not found, with the code the SFTP browser's errors carry, so callers can treat both alike. */
export class S3NotFound extends Error {
  readonly code = 'ENOENT'
  constructor(path: string) {
    super(`No such file or directory: ${path}`)
  }
}

/** `/a/b/` → `a/b`; `/` → ''. Refuses `..` so a path can never leave the bucket's namespace oddly. */
export function keyOf(path: string): string {
  const normal = posix.normalize(`/${path}`)
  if (normal.split('/').includes('..')) throw new Error(`"${path}" is not a path inside the bucket.`)
  return normal.replace(/^\/+/, '').replace(/\/+$/, '')
}

export const prefixOf = (path: string) => {
  const key = keyOf(path)
  return key ? `${key}/` : ''
}

const DIR_MODE = 0o755
const FILE_MODE = 0o644

export class S3Browser {
  constructor(readonly client: S3Client) {}

  async list(directory: string): Promise<S3Entry[]> {
    const prefix = prefixOf(directory)
    const out: S3Entry[] = []
    const base = posix.normalize(`/${keyOf(directory)}`)
    for await (const page of this.client.listAll(prefix, { delimiter: '/' })) {
      for (const sub of page.prefixes) {
        const name = sub.slice(prefix.length).replace(/\/$/, '')
        if (!name) continue
        out.push({ name, path: posix.join(base, name), type: 'directory', size: 0, modifiedAt: new Date(0).toISOString(), mode: DIR_MODE, uid: 0, gid: 0 })
      }
      for (const object of page.objects) {
        const name = object.key.slice(prefix.length)
        if (!name || name.includes('/')) continue // the directory's own marker
        out.push({
          name,
          path: posix.join(base, name),
          type: 'file',
          size: object.size,
          modifiedAt: object.lastModified.toISOString(),
          mode: FILE_MODE,
          uid: 0,
          gid: 0,
        })
      }
    }
    return out
  }

  async stat(path: string): Promise<S3Entry> {
    const key = keyOf(path)
    const name = posix.basename(`/${key}`) || '/'
    const normal = posix.normalize(`/${key}`)
    if (key === '') return { name: '/', path: '/', type: 'directory', size: 0, modifiedAt: new Date(0).toISOString(), mode: DIR_MODE, uid: 0, gid: 0 }
    const head = await this.client.head(key)
    if (head) {
      return {
        name,
        path: normal,
        type: 'file',
        size: head.size,
        modifiedAt: new Date(head.mtimeMs ?? head.lastModified.getTime()).toISOString(),
        mode: FILE_MODE,
        uid: 0,
        gid: 0,
      }
    }
    const page = await this.client.list({ prefix: `${key}/`, maxKeys: 1 })
    if (page.objects.length || page.prefixes.length) {
      return { name, path: normal, type: 'directory', size: 0, modifiedAt: new Date(0).toISOString(), mode: DIR_MODE, uid: 0, gid: 0 }
    }
    throw new S3NotFound(path)
  }

  async realpath(path: string): Promise<string> {
    return posix.normalize(`/${keyOf(path)}`)
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`${path}: S3 has no symbolic links.`)
  }

  async mkdir(path: string): Promise<void> {
    const key = keyOf(path)
    if (!key) return
    await this.client.put(`${key}/`, new Uint8Array(0), { contentType: 'application/x-directory' })
  }

  /** Copy then delete: S3 has no rename. A directory moves object by object. */
  async rename(from: string, to: string): Promise<void> {
    const source = await this.stat(from)
    const toKey = keyOf(to)
    if (!toKey) throw new Error('Cannot rename onto the bucket root.')
    if (source.type === 'file') {
      if (await this.client.head(toKey)) throw new Error(`${to} already exists.`)
      await this.client.copy(keyOf(from), toKey)
      await this.client.delete(keyOf(from))
      return
    }
    const fromPrefix = prefixOf(from)
    const toPrefix = `${toKey}/`
    if (toPrefix.startsWith(fromPrefix)) throw new Error('Cannot move a folder into itself.')
    const existing = await this.client.list({ prefix: toPrefix, maxKeys: 1 })
    if (existing.objects.length || existing.prefixes.length) throw new Error(`${to} already exists.`)
    const moved: string[] = []
    for await (const page of this.client.listAll(fromPrefix)) {
      for (const object of page.objects) {
        await this.client.copy(object.key, toPrefix + object.key.slice(fromPrefix.length))
        moved.push(object.key)
      }
    }
    await this.deleteAll(moved)
  }

  async unlink(path: string): Promise<void> {
    const key = keyOf(path)
    if (!(await this.client.head(key))) throw new S3NotFound(path)
    await this.client.delete(key)
  }

  /** Removes an empty folder: its marker. Refuses one with anything in it, as rmdir does. */
  async rmdir(path: string): Promise<void> {
    const prefix = prefixOf(path)
    const page = await this.client.list({ prefix, maxKeys: 2 })
    if (page.objects.some((object) => object.key !== prefix) || page.prefixes.length) throw new Error(`${path} is not empty.`)
    await this.client.delete(prefix)
  }

  async chmod(path: string): Promise<void> {
    throw new Error(`${path}: S3 objects have no permissions to change.`)
  }

  /** An empty object, refusing to replace one that exists. */
  async createFile(path: string): Promise<void> {
    const key = keyOf(path)
    if (!key) throw new Error('A file needs a name.')
    if (await this.client.head(key)) throw new Error(`${path} already exists.`)
    await this.client.put(key, new Uint8Array(0), { metadata: { mtime: String(Date.now()) } })
  }

  /** The first `limit` bytes, with a ranged GET, and the object's full size. */
  async readHead(path: string, limit: number): Promise<{ bytes: Buffer; size: number }> {
    const key = keyOf(path)
    try {
      const response = await this.client.get(key, { range: `bytes=0-${Math.max(0, limit - 1)}` })
      const bytes = Buffer.from(await response.arrayBuffer()).subarray(0, limit)
      const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
      return { bytes, size: total ? Number(total[1]) : bytes.length }
    } catch (error) {
      // A ranged GET of an empty object is 416 on AWS.
      if (error instanceof S3Error && error.status === 416) return { bytes: Buffer.alloc(0), size: 0 }
      if (error instanceof S3Error && error.status === 404) throw new S3NotFound(path)
      throw error
    }
  }

  async removeRecursive(path: string): Promise<void> {
    const key = keyOf(path)
    if (!key) throw new Error('Refusing to empty the whole bucket from the file browser.')
    const keys: string[] = []
    if (await this.client.head(key)) keys.push(key)
    for await (const page of this.client.listAll(`${key}/`)) keys.push(...page.objects.map((object) => object.key))
    await this.deleteAll(keys)
  }

  private async deleteAll(keys: readonly string[]): Promise<void> {
    const failed = await this.client.deleteMany(keys)
    if (failed.length) throw new Error(`Could not delete ${failed.length} object(s): ${failed[0]!.key} (${failed[0]!.message})`)
  }

  close(): void {}
}
