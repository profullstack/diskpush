/**
 * The S3 transfer engine: local ⇄ bucket, with rsync's semantics and rsync's
 * event stream.
 *
 * Every consumer of a transfer (the desktop job loop and preview, the CLI,
 * the TUI, Fleet Sync) reads `RsyncEvent`s, so this engine emits exactly
 * those, and an S3 job is a job like any other: previewable, cancellable,
 * logged, retried.
 *
 * What it keeps from rsync:
 *   - a trailing `/` on the source copies its contents, without one the
 *     directory itself
 *   - the quick check: same size and same modification time is unchanged.
 *     Uploads store the file's mtime as `x-amz-meta-mtime` and downloads set
 *     it back, so timestamps survive a round trip; `checksum` compares MD5s
 *   - `update`, `ignoreExisting`, `existingOnly`, include/exclude patterns,
 *     `filesFrom`, `minSize`/`maxSize`, `dryRun`
 *   - mirror deletes only with the preview confirmed, never touching excluded
 *     paths, exactly as the rsync planner enforces
 *   - exit 0 / 23 (some files failed) / 20 (cancelled)
 * What S3 cannot hold is said, not faked: symlinks and empty directories are
 * skipped on upload with a stderr line; permissions and owners do not exist.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Change, RsyncEvent, RsyncOptions, RsyncProgress, RsyncStats } from '@diskpush/schemas'
import { MAX_SINGLE_PUT, S3Client, headFromResponse, partSizeFor, type S3Object, type S3ObjectHead } from './client.js'
import { keyOf, prefixOf } from './browser.js'
import { compileFilter, parseRsyncSize } from './filters.js'

export type S3SyncOptions = Pick<
  RsyncOptions,
  | 'deleteMode'
  | 'dryRun'
  | 'excludes'
  | 'includes'
  | 'filesFrom'
  | 'from0'
  | 'checksum'
  | 'update'
  | 'ignoreExisting'
  | 'existingOnly'
  | 'itemizeAll'
  | 'maxSize'
  | 'minSize'
>

export type S3SyncSpec = {
  direction: 'upload' | 'download'
  client: S3Client
  /** The local path as given: a trailing separator is meaningful. */
  local: string
  /** The bucket path as given (`/backups/db/`): a trailing `/` is meaningful. */
  remote: string
  options: Partial<S3SyncOptions>
  deletesConfirmed?: boolean
  /** Files in flight at once. */
  concurrency?: number
}

export class S3SyncError extends Error {}

type LocalItem = { abs: string; size: number; mtimeMs: number }
type RemoteItem = S3Object & { head?: S3ObjectHead | null }

type Plan = {
  /** rel → what to do. */
  actions: Array<{ rel: string; action: 'add' | 'update' | 'unchanged' | 'delete'; size: number; src?: LocalItem | RemoteItem; dst?: LocalItem | RemoteItem }>
  /** Directories (rel) that exist only at the destination, deepest first, for a mirror. */
  deleteDirs: string[]
  skipped: string[]
  /** Where rel paths land at the destination. */
  destRoot: string
  /** Folder markers present at an S3 destination (dir rels). */
  markers: Set<string>
}

const MTIME_TOLERANCE_MS = 1000
const sameSecond = (a: number, b: number) => Math.abs(Math.floor(a / 1000) - Math.floor(b / 1000)) * 1000 < MTIME_TOLERANCE_MS

export function emptyS3Stats(): RsyncStats {
  return {
    filesTotal: 0,
    filesTransferred: 0,
    totalBytesSent: 0,
    totalBytesReceived: 0,
    literalBytes: 0,
    logicalBlocksTouched: null,
    matchedBytes: 0,
    speedup: null,
  }
}

async function md5File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function readList(path: string, nul: boolean): Promise<Set<string>> {
  const text = await readFile(path, 'utf8')
  return new Set(text.split(nul ? '\0' : /\r?\n/).map((line) => line.replace(/^\.?\/+/, '').replace(/\/+$/, '')).filter(Boolean))
}

function inSelection(rel: string, selection: Set<string> | null): boolean {
  if (!selection) return true
  for (const picked of selection) if (rel === picked || rel.startsWith(`${picked}/`)) return true
  return false
}

async function walkLocal(root: string, excluded: (rel: string, dir: boolean) => boolean, skipped: string[]) {
  const files = new Map<string, LocalItem>()
  const dirs = new Set<string>()
  const visit = async (dir: string, relDir: string) => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const abs = join(dir, name)
      const rel = relDir ? `${relDir}/${name}` : name
      const stats = await lstat(abs)
      if (stats.isSymbolicLink()) {
        if (!excluded(rel, false)) skipped.push(`${rel}: a symbolic link, which S3 cannot hold`)
        continue
      }
      if (stats.isDirectory()) {
        if (excluded(rel, true)) continue
        dirs.add(rel)
        await visit(abs, rel)
      } else if (stats.isFile()) {
        if (!excluded(rel, false)) files.set(rel, { abs, size: stats.size, mtimeMs: stats.mtimeMs })
      }
    }
  }
  await visit(root, '')
  return { files, dirs }
}

async function walkRemote(client: S3Client, prefix: string, excluded: (rel: string, dir: boolean) => boolean, signal?: AbortSignal) {
  const files = new Map<string, RemoteItem>()
  const dirs = new Set<string>()
  /** Folder marker objects (`dir/`) that really exist, by dir rel. */
  const markers = new Set<string>()
  for await (const page of client.listAll(prefix, signal ? { signal } : {})) {
    for (const object of page.objects) {
      const rel = object.key.slice(prefix.length)
      if (!rel) continue
      const parts = rel.split('/')
      // Every ancestor is a directory, excluded ones prune what is under them.
      let pruned = false
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (excluded(dir, true)) {
          pruned = true
          break
        }
        dirs.add(dir)
      }
      if (pruned) continue
      if (rel.endsWith('/')) {
        dirs.add(rel.slice(0, -1))
        markers.add(rel.slice(0, -1))
        continue
      }
      if (!excluded(rel, false)) files.set(rel, object)
    }
  }
  return { files, dirs, markers }
}

/**
 * Works out what a transfer would do. Exported for tests and for the dry-run
 * preview; `runS3Sync` calls it.
 */
export async function planS3Sync(spec: S3SyncSpec, signal?: AbortSignal): Promise<Plan> {
  const o = spec.options
  const deleting = (o.deleteMode ?? 'off') !== 'off'
  if (deleting && !o.dryRun && !spec.deletesConfirmed) {
    throw new S3SyncError('Mirror mode deletes destination files. Run the dry-run preview and confirm the delete list before building a live mirror job.')
  }
  const excluded = compileFilter(o.includes ?? [], o.excludes ?? [])
  const selection = o.filesFrom ? await readList(o.filesFrom, o.from0 ?? false) : null
  const minSize = o.minSize ? parseRsyncSize(o.minSize) : 0
  const maxSize = o.maxSize ? parseRsyncSize(o.maxSize) : Number.POSITIVE_INFINITY
  const skipped: string[] = []
  const client = spec.client

  let srcFiles: Map<string, LocalItem | RemoteItem>
  let srcDirs: Set<string>
  let dstFiles: Map<string, LocalItem | RemoteItem>
  let dstDirs: Set<string>
  let destRoot: string
  let markers = new Set<string>()

  if (spec.direction === 'upload') {
    const localStats = await stat(spec.local).catch(() => null)
    if (!localStats) throw new S3SyncError(`${spec.local} does not exist.`)
    const remoteIsDir = spec.remote.endsWith('/') || keyOf(spec.remote) === '' || (await isRemoteDir(client, spec.remote, signal))
    if (localStats.isFile()) {
      const name = basename(spec.local)
      const key = remoteIsDir ? prefixOf(spec.remote) + name : keyOf(spec.remote)
      destRoot = key.slice(0, key.lastIndexOf('/') + 1)
      const rel = key.slice(destRoot.length)
      srcFiles = new Map([[rel, { abs: spec.local, size: localStats.size, mtimeMs: localStats.mtimeMs }]])
      srcDirs = new Set()
      const existing = await client.head(key, signal)
      dstFiles = existing ? new Map([[rel, { ...existing }]]) : new Map()
      dstDirs = new Set()
    } else {
      const contents = /[\\/]$/.test(spec.local)
      destRoot = prefixOf(spec.remote) + (contents ? '' : `${basename(spec.local)}/`)
      const walked = await walkLocal(spec.local, excluded, skipped)
      srcFiles = walked.files
      srcDirs = walked.dirs
      const remote = await walkRemote(client, destRoot, excluded, signal)
      dstFiles = remote.files
      dstDirs = remote.dirs
      markers = remote.markers
    }
  } else {
    const key = keyOf(spec.remote)
    const head = !spec.remote.endsWith('/') && key ? await client.head(key, signal) : null
    const localStats = await stat(spec.local).catch(() => null)
    if (head) {
      const localIsDir = /[\\/]$/.test(spec.local) || localStats?.isDirectory() === true
      const target = localIsDir ? join(spec.local, posix.basename(key)) : spec.local
      const rel = basename(target)
      destRoot = dirname(target)
      srcFiles = new Map([[rel, { ...head, head }]])
      srcDirs = new Set()
      const existing = await stat(target).catch(() => null)
      dstFiles = existing?.isFile() ? new Map([[rel, { abs: target, size: existing.size, mtimeMs: existing.mtimeMs }]]) : new Map()
      dstDirs = new Set()
    } else {
      const contents = spec.remote.endsWith('/') || key === ''
      const prefix = prefixOf(spec.remote)
      destRoot = contents ? spec.local : join(spec.local, posix.basename(key))
      const remote = await walkRemote(client, prefix, excluded, signal)
      if (remote.files.size === 0 && remote.dirs.size === 0 && key !== '') {
        const page = await client.list({ prefix, maxKeys: 1, ...(signal ? { signal } : {}) })
        if (!page.objects.length) throw new S3SyncError(`s3://${client.settings.bucket}/${key} does not exist.`)
      }
      srcFiles = remote.files
      srcDirs = remote.dirs
      const walked = await walkLocal(destRoot, excluded, [])
      dstFiles = walked.files
      dstDirs = walked.dirs
    }
  }

  const actions: Plan['actions'] = []
  const needHead: Array<() => Promise<void>> = []

  for (const [rel, src] of srcFiles) {
    if (!inSelection(rel, selection)) continue
    if (src.size < minSize || src.size > maxSize) continue
    const dst = dstFiles.get(rel)
    if (!dst) {
      if (!o.existingOnly) actions.push({ rel, action: 'add', size: src.size, src })
      continue
    }
    if (o.ignoreExisting) {
      actions.push({ rel, action: 'unchanged', size: src.size, src, dst })
      continue
    }
    const entry: Plan['actions'][number] = { rel, action: 'update', size: src.size, src, dst }
    actions.push(entry)
    needHead.push(async () => {
      entry.action = (await isUnchanged(spec, src, dst, signal)) ? 'unchanged' : 'update'
    })
  }
  await pool(needHead, 8, signal)

  const deleteDirs: string[] = []
  if (deleting) {
    for (const [rel, dst] of dstFiles) {
      if (srcFiles.has(rel) || !inSelection(rel, selection)) continue
      actions.push({ rel, action: 'delete', size: dst.size, dst })
    }
    for (const dir of [...dstDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (!srcDirs.has(dir) && inSelection(dir, selection)) deleteDirs.push(dir)
    }
  }
  // Empty source directories have no object to become.
  if (spec.direction === 'upload') {
    for (const dir of srcDirs) {
      const hasChild = [...srcFiles.keys()].some((rel) => rel.startsWith(`${dir}/`))
      if (!hasChild && inSelection(dir, selection)) skipped.push(`${dir}/: an empty directory, which S3 cannot hold without a file in it`)
    }
  }
  return { actions, deleteDirs, skipped, destRoot, markers }
}

async function isRemoteDir(client: S3Client, remote: string, signal?: AbortSignal): Promise<boolean> {
  const page = await client.list({ prefix: prefixOf(remote), maxKeys: 1, ...(signal ? { signal } : {}) })
  return page.objects.length > 0 || page.prefixes.length > 0
}

async function headOf(spec: S3SyncSpec, item: RemoteItem, signal?: AbortSignal): Promise<S3ObjectHead | null> {
  if (item.head === undefined) item.head = await spec.client.head(item.key, signal)
  return item.head
}

async function isUnchanged(spec: S3SyncSpec, src: LocalItem | RemoteItem, dst: LocalItem | RemoteItem, signal?: AbortSignal): Promise<boolean> {
  const local = (spec.direction === 'upload' ? src : dst) as LocalItem
  const remote = (spec.direction === 'upload' ? dst : src) as RemoteItem
  if (local.size !== remote.size) {
    if (spec.options.update && newerAtDestination(spec, local, remote)) return true
    return false
  }
  const head = await headOf(spec, remote, signal)
  if (spec.options.checksum) {
    const remoteMd5 = head?.md5 ?? (remote.etag.includes('-') ? null : remote.etag)
    if (!remoteMd5) return false
    return (await md5File(local.abs, signal)) === remoteMd5.toLowerCase()
  }
  const remoteMtime = head?.mtimeMs ?? null
  if (remoteMtime !== null) {
    if (sameSecond(local.mtimeMs, remoteMtime)) return true
  } else if (spec.direction === 'upload' ? remote.lastModified.getTime() >= local.mtimeMs : sameSecond(local.mtimeMs, remote.lastModified.getTime())) {
    return true
  }
  return spec.options.update === true && newerAtDestination(spec, local, remote)
}

function newerAtDestination(spec: S3SyncSpec, local: LocalItem, remote: RemoteItem): boolean {
  const remoteTime = remote.head?.mtimeMs ?? remote.lastModified.getTime()
  return spec.direction === 'upload' ? remoteTime > local.mtimeMs : local.mtimeMs > remoteTime
}

async function pool(tasks: Array<() => Promise<void>>, limit: number, signal?: AbortSignal): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      signal?.throwIfAborted()
      await tasks[next++]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

export type S3RunHandle = { events: AsyncIterable<RsyncEvent>; cancel(): void }

export function runS3Sync(spec: S3SyncSpec, options: { signal?: AbortSignal } = {}): S3RunHandle {
  const controller = new AbortController()
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  const signal = controller.signal
  const queue: RsyncEvent[] = []
  const waiters: Array<(value: IteratorResult<RsyncEvent>) => void> = []
  let finished = false
  const push = (event: RsyncEvent) => {
    const waiter = waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else queue.push(event)
  }
  const finish = () => {
    finished = true
    while (waiters.length) waiters.shift()!({ value: undefined as never, done: true })
  }

  const run = async () => {
    const started = Date.now()
    const bucketPath = `s3://${spec.client.settings.bucket}/${keyOf(spec.remote)}${spec.remote.endsWith('/') ? '/' : ''}`
    push({ type: 'start', command: 's3', args: spec.direction === 'upload' ? [spec.local, bucketPath] : [bucketPath, spec.local] })
    const stats = emptyS3Stats()
    let failures = 0
    try {
      const plan = await planS3Sync(spec, signal)
      for (const line of plan.skipped) push({ type: 'stderr', line: `skipping ${line}` })
      const transfers = plan.actions.filter((a) => a.action === 'add' || a.action === 'update')
      const totalBytes = transfers.reduce((sum, a) => sum + a.size, 0)
      stats.filesTotal = plan.actions.filter((a) => a.action !== 'delete').length
      let doneBytes = 0
      let doneFiles = 0
      const progress = (): RsyncProgress => {
        const elapsed = (Date.now() - started) / 1000
        return {
          bytesTransferred: doneBytes,
          percent: totalBytes === 0 ? 100 : Math.min(100, Math.floor((doneBytes / totalBytes) * 100)),
          bytesPerSecond: elapsed > 0 ? Math.round(doneBytes / elapsed) : 0,
          elapsedSeconds: Math.round(elapsed),
          filesTransferred: doneFiles,
          filesRemaining: transfers.length - doneFiles,
          filesTotal: transfers.length,
        }
      }
      let lastProgress = 0
      const tick = (force = false) => {
        if (force || Date.now() - lastProgress > 250) {
          lastProgress = Date.now()
          push({ type: 'progress', progress: progress() })
        }
      }

      for (const action of plan.actions) {
        if (action.action === 'unchanged' && !spec.options.itemizeAll) continue
        const change: Change = { action: action.action, path: action.rel, itemize: null, isDirectory: false, size: action.size }
        push({ type: 'change', change })
      }
      for (const dir of plan.deleteDirs) {
        push({ type: 'change', change: { action: 'delete', path: `${dir}/`, itemize: null, isDirectory: true, size: null } })
      }

      if (!spec.options.dryRun) {
        await pool(
          transfers.map((action) => async () => {
            try {
              const moved = spec.direction === 'upload'
                ? await upload(spec, plan.destRoot, action.rel, action.src as LocalItem, (n) => ((doneBytes += n), tick()), signal)
                : await download(spec, plan.destRoot, action.rel, action.src as RemoteItem, (n) => ((doneBytes += n), tick()), signal)
              doneFiles++
              stats.filesTransferred = doneFiles
              if (spec.direction === 'upload') stats.totalBytesSent = (stats.totalBytesSent ?? 0) + moved
              else stats.totalBytesReceived = (stats.totalBytesReceived ?? 0) + moved
              stats.literalBytes = (stats.literalBytes ?? 0) + moved
              push({ type: 'file', path: action.rel })
            } catch (error) {
              if (signal.aborted) throw error
              failures++
              push({ type: 'change', change: { action: 'error', path: action.rel, itemize: null, isDirectory: false, size: action.size } })
              push({ type: 'stderr', line: `${action.rel}: ${error instanceof Error ? error.message : String(error)}` })
            }
          }),
          spec.concurrency ?? 4,
          signal,
        )
        const deletions = plan.actions.filter((a) => a.action === 'delete')
        if (deletions.length) {
          if (spec.direction === 'upload') {
            const keys = deletions.map((a) => plan.destRoot + a.rel)
            // Only markers that exist: a prefix with no marker object vanishes with its last key.
            keys.push(...plan.deleteDirs.filter((dir) => plan.markers.has(dir)).map((dir) => `${plan.destRoot}${dir}/`))
            const refused = await spec.client.deleteMany(keys, signal)
            for (const r of refused) {
              failures++
              push({ type: 'stderr', line: `could not delete ${r.key}: ${r.message}` })
            }
          } else {
            for (const a of deletions) await rm(join(plan.destRoot, ...a.rel.split('/')), { force: true })
            for (const dir of plan.deleteDirs) await rmdir(join(plan.destRoot, ...dir.split('/'))).catch(() => {})
          }
        }
        stats.matchedBytes = plan.actions.filter((a) => a.action === 'unchanged').reduce((sum, a) => sum + a.size, 0)
        tick(true)
      }
      push({ type: 'stats', stats })
      push(
        failures
          ? { type: 'exit', code: 23, signal: null, resumable: true, message: `${failures} file(s) could not be transferred; the rest were. Run it again to retry them.` }
          : { type: 'exit', code: 0, signal: null, resumable: false, message: 'Transfer completed.' },
      )
    } catch (error) {
      if (signal.aborted) {
        push({ type: 'exit', code: 20, signal: 'SIGTERM', resumable: true, message: 'Transfer cancelled. Finished files stay; run it again to continue.' })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        push({ type: 'stderr', line: message })
        push({ type: 'exit', code: 1, signal: null, resumable: false, message })
      }
    } finally {
      finish()
    }
  }
  void run()

  return {
    cancel: () => controller.abort(),
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          queue.length
            ? Promise.resolve({ value: queue.shift()!, done: false })
            : finished
              ? Promise.resolve({ value: undefined as never, done: true })
              : new Promise((resolve) => waiters.push(resolve)),
      }),
    },
  }
}

async function upload(spec: S3SyncSpec, destRoot: string, rel: string, item: LocalItem, onBytes: (n: number) => void, signal: AbortSignal): Promise<number> {
  const key = destRoot + rel
  const metadata: Record<string, string> = { mtime: String(Math.floor(item.mtimeMs)) }
  if (spec.options.checksum) metadata.md5 = await md5File(item.abs, signal)
  if (item.size <= MAX_SINGLE_PUT) {
    const body = await readFile(item.abs, { signal })
    await spec.client.put(key, body, { metadata, signal })
    onBytes(body.length)
    return body.length
  }
  const partSize = partSizeFor(item.size)
  const uploadId = await spec.client.createMultipart(key, { metadata, signal })
  const handle = await open(item.abs, 'r')
  try {
    const parts: Array<{ partNumber: number; etag: string }> = []
    let offset = 0
    for (let partNumber = 1; offset < item.size; partNumber++) {
      const length = Math.min(partSize, item.size - offset)
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
        if (bytesRead === 0) throw new Error(`${item.abs} shrank while it was being uploaded.`)
        read += bytesRead
      }
      parts.push({ partNumber, etag: await spec.client.uploadPart(key, uploadId, partNumber, buffer, signal) })
      offset += length
      onBytes(length)
    }
    await spec.client.completeMultipart(key, uploadId, parts, signal)
    return item.size
  } catch (error) {
    await spec.client.abortMultipart(key, uploadId).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }
}

async function download(spec: S3SyncSpec, destRoot: string, rel: string, item: RemoteItem, onBytes: (n: number) => void, signal: AbortSignal): Promise<number> {
  const target = join(destRoot, ...rel.split('/'))
  await mkdir(dirname(target), { recursive: true })
  const partial = join(dirname(target), `.${basename(target)}.diskpush-partial`)
  const response = await spec.client.get(item.key, { signal })
  const head = headFromResponse(item.key, response)
  let bytes = 0
  try {
    if (!response.body) throw new Error('S3 returned no body.')
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length
          onBytes(chunk.length)
          done(null, chunk)
        },
      }),
      createWriteStream(partial),
      { signal },
    )
    const when = new Date(head.mtimeMs ?? head.lastModified.getTime())
    await utimes(partial, when, when)
    await rename(partial, target)
    return bytes
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}
