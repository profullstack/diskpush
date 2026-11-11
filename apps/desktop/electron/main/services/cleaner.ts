/**
 * The Cleaner tab, in the main process.
 *
 * Scans and applies run here through the cleaner plugin's own core (the same
 * code the CLI and MCP use), with the plugin's settings and the Fleet tab's
 * servers. A scan's report is kept here under an id; an apply names that id
 * and item ids from it, so the renderer can choose among findings but can
 * never name a path of its own. Progress goes out on `plugins:progress`.
 */
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { PluginError } from '@diskpush/plugin-api'
import { applyClean, listTargets, scanTarget, CLEANER_ID, type ApplyResult, type Report, type Target } from '@diskpush/plugin-cleaner'
import { IPC, type CleanerApplyRequest, type CleanerScanRequest } from '../../shared/contract.js'
import { pluginHostContext, pluginRegistry } from './plugins.js'

const reports = new Map<string, Report>()
const running = new Map<string, AbortController>()

async function requireEnabled(): Promise<void> {
  const { registry } = await pluginRegistry()
  if (!registry.has(CLEANER_ID)) throw new PluginError('The Cleaner plugin is not installed.')
  if (!(await registry.isEnabled(CLEANER_ID))) throw new PluginError('The Cleaner plugin is disabled. Turn it on under Plugins….')
}

export async function cleanerTargets(): Promise<Target[]> {
  await requireEnabled()
  return listTargets(await pluginHostContext(CLEANER_ID, 'cleaner-targets', null, new AbortController().signal))
}

async function track<T>(jobId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (running.has(jobId)) throw new PluginError('That job id is already running.')
  const controller = new AbortController()
  running.set(jobId, controller)
  try {
    return await work(controller.signal)
  } finally {
    running.delete(jobId)
  }
}

export type CleanerScanResult = { reportId: string; report: Report }

export async function cleanerScan(request: CleanerScanRequest, sender: WebContents): Promise<CleanerScanResult> {
  await requireEnabled()
  return track(request.jobId, async (signal) => {
    const ctx = await pluginHostContext(CLEANER_ID, request.jobId, sender, signal)
    const report = await scanTarget(ctx, request.target, {
      ...(request.only.length ? { only: request.only } : {}),
      ...(request.idleDays ? { idleDays: request.idleDays } : {}),
    })
    const reportId = randomUUID()
    // One report per target is enough to apply from; older ones go.
    for (const [id, old] of reports) if (old.target === report.target) reports.delete(id)
    reports.set(reportId, report)
    return { reportId, report }
  })
}

export async function cleanerApply(request: CleanerApplyRequest, sender: WebContents): Promise<ApplyResult> {
  await requireEnabled()
  const report = reports.get(request.reportId)
  if (!report) throw new PluginError('That report is gone; scan again first.')
  return track(request.jobId, async (signal) => {
    const ctx = await pluginHostContext(CLEANER_ID, request.jobId, sender, signal)
    const result = await applyClean(ctx, report, { apply: true, ids: request.ids })
    // What was removed is no longer in the report; a re-scan shows the new state.
    reports.delete(request.reportId)
    if (!sender.isDestroyed()) {
      sender.send(IPC.eventPlugin, { jobId: request.jobId, event: { type: 'exit', ok: true, message: 'done', changed: true, cancelled: signal.aborted } })
    }
    return result
  })
}

export function cleanerCancel(jobId: string): boolean {
  const controller = running.get(jobId)
  if (!controller) return false
  controller.abort()
  return true
}
