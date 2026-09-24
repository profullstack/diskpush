/**
 * One analysis run: collect, upload what has not been, wait for results,
 * write sidecars, and optionally sort.
 *
 * Resumable at every step. The state file records the scan, which files went
 * up and every result, and it is saved after each batch and each poll, so an
 * interrupted run (a closed laptop, a cancel, a crash) picks up where it
 * stopped the next time the action runs, without uploading or paying again.
 */
import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import type { PluginSettings, ProgressSink } from '@diskpush/plugin-api'
import { SIGNATURE, readOurSidecar, sortIntoFolders, writeSidecar, type SortItem, type SortReport } from './apply.js'
import { chooseTier, type FileResult, type MediaAnalyzerClient, type UploadMeta } from './client.js'
import { collectMedia, loadState, saveState, type MediaFile, type Result, type State } from './library.js'
import { MAX_UPLOAD_BYTES, findFfmpeg, mimeType, type Ffmpeg } from './media.js'
import { ApiError } from './oauth.js'
import type { EntryRef } from '@diskpush/plugin-api'

export const MAX_FILES_PER_REQUEST = 50
/** Keeps one request, and the memory behind it, bounded. A single file up to the server's 30 MB always fits. */
export const MAX_BYTES_PER_REQUEST = 64 * 1024 * 1024
export const POLL_INTERVAL_MS = 2500

export type AnalyzeOptions = {
  dir: string
  entries: readonly EntryRef[]
  sort: boolean
  client: MediaAnalyzerClient
  settings: PluginSettings
  progress: ProgressSink
  signal: AbortSignal
  /** Undefined looks on PATH; null means "there is none". */
  ffmpeg?: Ffmpeg | null
  pollIntervalMs?: number
}

export type AnalyzeReport = {
  ok: boolean
  message: string
  files: number
  described: number
  failed: number
  /** Never uploaded: no credit, too large, no ffmpeg. */
  notUploaded: number
  sidecarsWritten: number
  sidecarsKept: number
  sort: SortReport | null
  chargedUsd: number | null
  changed: boolean
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

function toResult(file: FileResult): Result {
  return {
    status: file.status === 'done' ? 'done' : 'error',
    category: file.category ?? null,
    description: file.description ?? null,
    tags: Array.isArray(file.tags) ? file.tags : [],
    error: file.error ?? null,
  }
}

/** What is sent for one file: its bytes, and the metadata that describes them. */
type Prepared = { file: MediaFile; blob: Blob; meta: UploadMeta }

async function prepare(file: MediaFile, ffmpeg: Ffmpeg | null, signal: AbortSignal): Promise<Prepared | string> {
  const meta: UploadMeta = { client_ref: file.ref, name: file.name, rel_path: file.rel, kind: file.kind, bytes: file.bytes }
  if (file.kind === 'photo') {
    if (file.bytes > MAX_UPLOAD_BYTES) return 'larger than 30 MB'
    return { file, meta, blob: await openAsBlob(file.abs, { type: mimeType(file.name) }) }
  }
  if (!ffmpeg) return 'videos need ffmpeg and ffprobe on PATH'
  try {
    const duration = await ffmpeg.duration(file.abs, signal)
    const sheet = await ffmpeg.contactSheet(file.abs, duration, signal)
    if (sheet.length === 0) return 'ffmpeg produced no frames'
    return {
      file,
      meta: { ...meta, frames: 9, duration_seconds: Math.round(duration * 10) / 10 },
      blob: new Blob([new Uint8Array(sheet)], { type: 'image/jpeg' }),
    }
  } catch (error) {
    if (signal.aborted) throw error
    return `could not read the video: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Splits files into requests of at most 50 files and 64 MB. */
export function batches<T extends { meta: { bytes: number } ; blob: Blob }>(items: readonly T[]): T[][] {
  const out: T[][] = []
  let current: T[] = []
  let size = 0
  for (const item of items) {
    if (current.length > 0 && (current.length >= MAX_FILES_PER_REQUEST || size + item.blob.size > MAX_BYTES_PER_REQUEST)) {
      out.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += item.blob.size
  }
  if (current.length > 0) out.push(current)
  return out
}

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeReport> {
  const { dir, client, progress, signal } = options
  const report: AnalyzeReport = {
    ok: true,
    message: '',
    files: 0,
    described: 0,
    failed: 0,
    notUploaded: 0,
    sidecarsWritten: 0,
    sidecarsKept: 0,
    sort: null,
    chargedUsd: null,
    changed: false,
  }

  progress.update({ message: 'Looking for photos and videos…' })
  const files = await collectMedia(dir, options.entries, signal)
  report.files = files.length
  if (files.length === 0) {
    return { ...report, message: 'No photos or videos in that selection.' }
  }
  progress.start(files.length)

  const server = await client.server()
  const state: State = await loadState(dir)
  if (state.server !== server) {
    // Results are per server; a state file from another one is a fresh start.
    Object.assign(state, { server, scanId: null, tier: null, cursor: '', files: {} })
  }

  const byRef = new Map(files.map((file) => [file.ref, file]))
  const sortItems = new Map<string, SortItem>()
  let finished = 0
  const tick = (file: MediaFile | null, message?: string) =>
    progress.update({ done: finished, total: files.length, ...(file ? { currentFile: file.rel } : {}), ...(message ? { message } : {}) })

  const record = async (file: MediaFile, result: Result) => {
    state.files[file.ref] = { ...(state.files[file.ref] ?? { rel: file.rel, uploaded: true }), result }
    finished += 1
    if (result.status === 'done') {
      report.described += 1
      const outcome = await writeSidecar(file.abs, result)
      if (outcome === 'written') {
        report.sidecarsWritten += 1
        report.changed = true
      } else {
        report.sidecarsKept += 1
        progress.log('warn', `${file.rel}.description.txt is not ours; left it as it was.`)
      }
      sortItems.set(file.ref, { rel: file.rel, category: result.category })
    } else {
      report.failed += 1
      progress.log('error', `${file.rel}: ${result.error ?? 'failed'}`)
    }
    tick(file)
  }

  // --- what is already known --------------------------------------------------
  const toUpload: MediaFile[] = []
  for (const file of files) {
    const known = state.files[file.ref]
    if (known?.result) {
      finished += 1
      if (known.result.status === 'done') {
        report.described += 1
        if ((await writeSidecar(file.abs, known.result)) === 'written') report.sidecarsWritten += 1
        sortItems.set(file.ref, { rel: file.rel, category: known.result.category })
      } else report.failed += 1
      continue
    }
    if (known?.uploaded) continue
    // A sidecar we wrote on an earlier run, or that the MediaAnalyzer CLI
    // wrote: the file has been described, and describing it again costs money.
    const sidecar = await readOurSidecar(file.abs)
    if (sidecar) {
      finished += 1
      report.described += 1
      sortItems.set(file.ref, { rel: file.rel, category: sidecar.category })
      continue
    }
    toUpload.push(file)
  }
  tick(null)

  const ffmpeg = options.ffmpeg === undefined ? (toUpload.some((file) => file.kind === 'video') ? await findFfmpeg() : null) : options.ffmpeg

  // --- upload -----------------------------------------------------------------
  if (toUpload.length > 0) {
    if (!state.scanId) {
      progress.update({ message: 'Starting a MediaAnalyzer scan…' })
      const me = await client.me()
      const choice = chooseTier(me, {
        tier: await options.settings.get('tier', ''),
        providerId: await options.settings.get('providerId', ''),
      })
      const folders = String(await options.settings.get('folders', ''))
        .split(',')
        .map((folder) => folder.trim())
        .filter(Boolean)
      const scan = await client.createScan({
        name: `DiskPush: ${basename(dir)}`,
        ...choice,
        ...(folders.length > 0 ? { categories: folders } : {}),
      })
      state.scanId = scan.id
      state.tier = choice.tier
      await saveState(dir, state)
    }

    const prepared: Prepared[] = []
    for (const file of toUpload) {
      const ready = await prepare(file, ffmpeg, signal)
      if (typeof ready === 'string') {
        report.notUploaded += 1
        finished += 1
        progress.log('warn', `${file.rel}: skipped, ${ready}`)
        continue
      }
      prepared.push(ready)
    }

    let outOfCredit = false
    for (const batch of batches(prepared)) {
      signal.throwIfAborted()
      if (outOfCredit) {
        report.notUploaded += batch.length
        finished += batch.length
        continue
      }
      tick(batch[0]!.file, `Uploading ${batch.length} file${batch.length === 1 ? '' : 's'}…`)
      const form = new FormData()
      form.append('meta', JSON.stringify(batch.map((item) => item.meta)))
      batch.forEach((item, index) => form.append(`file${index}`, item.blob, item.file.name))
      try {
        const result = await client.uploadFiles(state.scanId!, form)
        const rejected = new Map(result.rejected.map((entry) => [entry.client_ref, entry.reason]))
        for (const item of batch) {
          const reason = rejected.get(item.file.ref)
          state.files[item.file.ref] = reason
            ? { rel: item.file.rel, uploaded: false, skipped: reason }
            : { rel: item.file.rel, uploaded: true }
          if (reason) {
            report.notUploaded += 1
            finished += 1
            progress.log('warn', `${item.file.rel}: the server would not take it (${reason})`)
          }
        }
        await saveState(dir, state)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'insufficient_credit') {
          outOfCredit = true
          report.ok = false
          report.notUploaded += batch.length
          finished += batch.length
          progress.log('error', `Out of MediaAnalyzer credit: ${error.message}`)
          continue
        }
        if (error instanceof ApiError && error.code === 'tier_offline') {
          throw new Error(`The ${state.tier ?? 'chosen'} tier is offline right now. Try again later, or pick another tier in the plugin's settings.`)
        }
        if (error instanceof ApiError && (error.code === 'scan_canceled' || error.status === 404)) {
          // The scan was cancelled on the website. The next run starts a new one.
          state.scanId = null
          state.cursor = ''
          await saveState(dir, state)
          throw new Error('That MediaAnalyzer scan was cancelled. Run the action again to start a new one.')
        }
        throw error
      }
    }
    if (outOfCredit) report.message = `Out of credit: ${report.notUploaded} file${report.notUploaded === 1 ? '' : 's'} not uploaded. Add credit at ${server}/billing and run it again.`
  }

  // --- results ----------------------------------------------------------------
  const waiting = new Set(
    Object.entries(state.files)
      .filter(([ref, entry]) => entry.uploaded && !entry.result && byRef.has(ref))
      .map(([ref]) => ref),
  )
  if (waiting.size > 0 && state.scanId) {
    let quiet = 0
    tick(null, `Waiting for ${waiting.size} description${waiting.size === 1 ? '' : 's'}…`)
    while (waiting.size > 0) {
      signal.throwIfAborted()
      const page = await client.files(state.scanId, state.cursor)
      let fresh = 0
      for (const remote of page.files) {
        // The cursor is inclusive, so the last file of one page is the first
        // of the next: only a ref still waiting counts.
        if (!waiting.has(remote.client_ref) || (remote.status !== 'done' && remote.status !== 'error')) continue
        waiting.delete(remote.client_ref)
        fresh += 1
        await record(byRef.get(remote.client_ref)!, toResult(remote))
      }
      if (page.next_finished_after) state.cursor = page.next_finished_after
      if (fresh > 0) await saveState(dir, state)
      if (waiting.size === 0) break

      quiet = fresh > 0 ? 0 : quiet + 1
      // Long silence: ask the scan whether anything is still coming.
      if (quiet > 0 && quiet % 8 === 0) {
        const scan = await client.scan(state.scanId)
        if (scan.done_count + scan.error_count >= scan.file_count && scan.file_count > 0) {
          const settled = await client.files(state.scanId, '')
          for (const remote of settled.files) {
            if (!waiting.has(remote.client_ref)) continue
            waiting.delete(remote.client_ref)
            await record(byRef.get(remote.client_ref)!, toResult(remote))
          }
          for (const ref of waiting) {
            await record(byRef.get(ref)!, { status: 'error', category: null, description: null, tags: [], error: 'the scan finished without it' })
          }
          waiting.clear()
          await saveState(dir, state)
          break
        }
      }
      await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS, signal)
    }
  }

  if (state.scanId) {
    try {
      report.chargedUsd = (await client.scan(state.scanId)).charged_usd
    } catch {
      // A figure for the summary line, not worth failing the run over.
    }
  }

  // --- sort -------------------------------------------------------------------
  if (options.sort && sortItems.size > 0) {
    progress.update({ message: 'Sorting into folders…' })
    report.sort = await sortIntoFolders(dir, [...sortItems.values()], { signal })
    if (report.sort.moved > 0) report.changed = true
    for (const failure of report.sort.failed) progress.log('warn', failure)
  }

  progress.update({ done: files.length, total: files.length })
  if (!report.message) report.message = summarize(report)
  else report.message = `${summarize(report)} ${report.message}`
  return report
}

function summarize(report: AnalyzeReport): string {
  const parts = [`Described ${report.described} of ${report.files} file${report.files === 1 ? '' : 's'}`]
  if (report.failed > 0) parts.push(`${report.failed} failed`)
  if (report.notUploaded > 0) parts.push(`${report.notUploaded} skipped`)
  if (report.sort) parts.push(`${report.sort.moved} moved into folders`)
  if (report.chargedUsd !== null) parts.push(`$${report.chargedUsd.toFixed(2)} charged to this scan`)
  return `${parts.join(', ')}.`
}

export { SIGNATURE }
