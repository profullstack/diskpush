/**
 * Running the tools: a dump streams straight from the dump tool through gzip
 * into a hidden `.partial` file, and becomes a backup (renamed into place)
 * only when the tool exited 0 AND the stream ended with the tool's own
 * "dump complete" line. A backup that exists is therefore a whole one.
 */
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { sqliteQuote } from './engines.js'

export type Env = Readonly<Record<string, string | undefined>>

/** The last `size` bytes of whatever passes through, without holding the rest. */
class Tail extends Transform {
  private buffer = Buffer.alloc(0)
  constructor(private readonly size = 4096) {
    super()
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null, data?: Buffer) => void) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > this.size) this.buffer = this.buffer.subarray(this.buffer.length - this.size)
    done(null, chunk)
  }
  text(): string {
    return this.buffer.toString('utf8')
  }
}

function childEnv(env: Env, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return { ...out, ...extra, LC_ALL: out.LC_ALL ?? 'C' }
}

export class ToolFailed extends Error {
  constructor(program: string, code: number | null, stderr: string) {
    const detail = stderr.trim().split('\n').slice(-6).join('\n')
    super(`${program} ${code === null ? 'was stopped' : `exited ${code}`}${detail ? `:\n${detail}` : ''}`)
  }
}

type RunOptions = {
  program: string
  args: readonly string[]
  env: Env
  extraEnv?: Record<string, string>
  signal: AbortSignal
  /** Piped to the child's stdin. */
  stdin?: Readable
  /** Receives the child's stdout. */
  stdout?: Writable
}

/** Runs a program to completion; rejects with its stderr when it fails. */
export function run(options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new Error('Cancelled.'))
    const child = spawn(options.program, [...options.args], {
      env: childEnv(options.env, options.extraEnv ?? {}),
      stdio: [options.stdin ? 'pipe' : 'ignore', options.stdout ? 'pipe' : 'ignore', 'pipe'],
      signal: options.signal,
    })
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      stderr = (stderr + text).slice(-16_384)
    })
    const piping: Promise<unknown>[] = []
    if (options.stdin) piping.push(pipeline(options.stdin, child.stdin!).catch(() => {}))
    if (options.stdout) piping.push(pipeline(child.stdout!, options.stdout))
    let settled = false
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(options.signal.aborted ? new Error('Cancelled.') : error)
    })
    child.on('close', async (code) => {
      if (settled) return
      settled = true
      try {
        await Promise.all(piping)
      } catch (error) {
        return reject(error)
      }
      if (options.signal.aborted) return reject(new Error('Cancelled.'))
      if (code !== 0) return reject(new ToolFailed(options.program, code, stderr))
      resolve()
    })
  })
}

export type DumpResult = { path: string; bytes: number }

/**
 * pg_dump / mysqldump → gzip → `<final>`. `trailer` is the line the tool ends
 * a complete dump with; without it the dump is thrown away.
 */
export async function dumpToFile(options: {
  program: string
  args: readonly string[]
  extraEnv: Record<string, string>
  env: Env
  signal: AbortSignal
  final: string
  trailer: string
}): Promise<DumpResult> {
  await mkdir(dirname(options.final), { recursive: true })
  const partial = join(dirname(options.final), `.${options.final.split(/[\\/]/).pop()}.partial`)
  const tail = new Tail()
  const gzip = createGzip({ level: 6 })
  const out = createWriteStream(partial, { mode: 0o600 })
  const sink = new PassThrough()
  const writing = pipeline(sink, tail, gzip, out)
  try {
    await Promise.all([
      run({ program: options.program, args: options.args, env: options.env, extraEnv: options.extraEnv, signal: options.signal, stdout: sink }),
      writing,
    ])
    if (!tail.text().includes(options.trailer)) {
      throw new Error(`The dump ended without "${options.trailer}", so it is incomplete and was discarded.`)
    }
    await rename(partial, options.final)
    return { path: options.final, bytes: (await stat(options.final)).size }
  } catch (error) {
    sink.destroy()
    await rm(partial, { force: true })
    throw error
  }
}

type NodeSqlite = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(): Array<Record<string, unknown>> }
    close(): void
  }
  backup?: (source: unknown, destination: string) => Promise<number>
}

/** `node:sqlite` when this Node has its online backup (22.16+, 23.8+); null in Electron 33 (Node 20). */
async function nodeSqlite(): Promise<NodeSqlite | null> {
  try {
    const mod = (await import('node:sqlite' as string)) as NodeSqlite
    return typeof mod.backup === 'function' ? mod : null
  } catch {
    return null
  }
}

/**
 * A consistent copy of a live SQLite database, using SQLite's own online
 * backup (never a file copy, which can catch a half-written page or miss the
 * WAL), checked with `PRAGMA quick_check`, then gzipped to `final`.
 */
export async function sqliteToFile(options: {
  source: string
  final: string
  sqlite3: string | null
  env: Env
  signal: AbortSignal
  /** Tests set false to exercise the sqlite3 binary on a Node that has node:sqlite. */
  useNodeSqlite?: boolean
}): Promise<DumpResult> {
  await stat(options.source) // a clear ENOENT before anything is created
  await mkdir(dirname(options.final), { recursive: true })
  const work = await mkdtemp(join(tmpdir(), 'diskpush-dbbackup-'))
  const copy = join(work, 'copy.sqlite')
  const partial = join(dirname(options.final), `.${options.final.split(/[\\/]/).pop()}.partial`)
  try {
    const sqlite = options.useNodeSqlite === false ? null : await nodeSqlite()
    if (sqlite) {
      const db = new sqlite.DatabaseSync(options.source, { readOnly: true })
      try {
        await sqlite.backup!(db, copy)
      } finally {
        db.close()
      }
      const check = new sqlite.DatabaseSync(copy, { readOnly: true })
      try {
        const rows = check.prepare('PRAGMA quick_check').all()
        const verdict = String(Object.values(rows[0] ?? {})[0] ?? '')
        if (verdict !== 'ok') throw new Error(`The copy failed its integrity check: ${verdict}`)
      } finally {
        check.close()
      }
    } else if (options.sqlite3) {
      await run({ program: options.sqlite3, args: [options.source, `.backup ${sqliteQuote(copy)}`], env: options.env, signal: options.signal })
      const verdict = new PassThrough()
      let text = ''
      verdict.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
      await run({ program: options.sqlite3, args: ['-readonly', copy, 'PRAGMA quick_check;'], env: options.env, signal: options.signal, stdout: verdict })
      if (text.trim() !== 'ok') throw new Error(`The copy failed its integrity check: ${text.trim()}`)
    } else {
      throw new Error('No way to read SQLite here: neither node:sqlite with backup() nor a sqlite3 binary.')
    }
    await pipeline(createReadStream(copy), createGzip({ level: 6 }), createWriteStream(partial, { mode: 0o600 }))
    await rename(partial, options.final)
    return { path: options.final, bytes: (await stat(options.final)).size }
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Reads a backup end to end: the gzip must be whole, and a SQL dump must end
 * with its tool's trailer. Returns the uncompressed size.
 */
export async function verifyFile(path: string, trailers: readonly string[] | null, signal?: AbortSignal): Promise<{ bytes: number }> {
  const tail = new Tail()
  let bytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length
      done(null, chunk)
    },
  })
  const discard = new PassThrough()
  discard.resume()
  await pipeline(createReadStream(path), createGunzip(), counter, tail, discard, signal ? { signal } : {})
  if (trailers && !trailers.some((line) => tail.text().includes(line))) {
    throw new Error('The dump does not end with a "dump complete" line: it was cut short.')
  }
  return { bytes }
}

/** A gunzipping stream of a backup, for a restore tool's stdin. */
export function gunzipStream(path: string): Readable {
  return createReadStream(path).pipe(createGunzip())
}

/** A `.sqlite.gz` back into a database file at `target`, via a temporary name beside it. */
export async function restoreSqliteFile(path: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const partial = `${target}.diskpush-restore.partial`
  try {
    await pipeline(createReadStream(path), createGunzip(), createWriteStream(partial, { mode: 0o600 }))
    await rename(partial, target)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}

/**
 * Copies one database's backup folder to `destination/<name>/` with rsync.
 *
 * `--delete` makes the destination follow local pruning, but the protect
 * filter limits it to files named `<name>--*`: even a destination typed wrong
 * (a home directory, `/`) can only ever lose backups this plugin made.
 */
export function rsyncPushArgs(localDir: string, destination: string, name: string, rsh?: string): string[] {
  const dest = `${destination.replace(/\/+$/, '')}/${name}/`
  const args = ['--archive', '--partial', '--mkpath', '--delete', `--filter=P! ${name}--*`, '--exclude=.*']
  if (rsh) args.push('--rsh', rsh)
  args.push(`${localDir.replace(/\/+$/, '')}/`, dest)
  return args
}
