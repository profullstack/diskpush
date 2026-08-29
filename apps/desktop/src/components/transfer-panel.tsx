'use client'

import type { PreviewResult } from '@/lib/api'
import { formatBytes, formatRate } from '@/lib/format'
import { Banner, Button, Dialog } from './ui'

export type ActiveJob = {
  jobId: string
  percent: number
  bytesTransferred: number
  bytesPerSecond: number
  files: number
  finished: boolean
  resumable: boolean
  message: string
}

/**
 * The delete preview.
 *
 * Every proposed deletion is listed, not summarised, because "87 files" is not
 * something anyone can consent to. The confirm button says what it does.
 */
export function MirrorPreviewDialog({
  preview,
  open,
  onCancel,
  onConfirm,
}: {
  preview: PreviewResult | null
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const deleteCount = preview?.deletes.length ?? 0

  return (
    <Dialog
      wide
      open={open}
      title="Mirror preview"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={deleteCount > 0 ? 'danger' : 'primary'} onClick={onConfirm} disabled={!preview?.ok}>
            {deleteCount > 0 ? `Delete ${deleteCount} and mirror` : 'Mirror'}
          </Button>
        </>
      }
    >
      {!preview ? (
        <p className="text-muted">Scanning…</p>
      ) : !preview.ok ? (
        <Banner kind="danger">{preview.message}</Banner>
      ) : (
        <div className="space-y-4">
          <table className="w-full text-[12px]">
            <tbody>
              {(['add', 'update', 'metadata', 'unchanged', 'delete'] as const).map((action) => (
                <tr key={action} className="border-b border-line/50">
                  <td className={`py-1 capitalize ${action === 'delete' ? 'text-danger' : ''}`}>{action}</td>
                  <td className="py-1 text-right tabular-nums">{preview.summary[action] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {deleteCount > 0 ? (
            <div>
              <Banner kind="danger">
                {deleteCount} file{deleteCount === 1 ? '' : 's'} at the destination will be deleted. This cannot be undone.
              </Banner>
              <ul className="mt-2 max-h-56 select-text overflow-auto rounded-md border border-line bg-ink p-2 font-mono text-[11px]">
                {preview.deletes.map((path) => (
                  <li key={path} className="py-0.5 text-danger">
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Banner kind="info">Nothing at the destination would be deleted.</Banner>
          )}

          {preview.warnings.map((warning) => (
            <Banner key={warning} kind="warn">
              {warning}
            </Banner>
          ))}

          <details>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-muted">
              Effective rsync command
            </summary>
            <pre className="mt-2 select-text overflow-x-auto rounded-md border border-line bg-ink p-2 font-mono text-[11px]">
              {preview.command}
            </pre>
            {preview.control ? (
              <pre className="mt-1 select-text overflow-x-auto rounded-md border border-line bg-ink p-2 font-mono text-[11px] text-muted">
                {`# control session: ${preview.control}`}
              </pre>
            ) : null}
          </details>
        </div>
      )}
    </Dialog>
  )
}

/** The queue row. One job at a time in this build; the shape is the queue's. */
export function TransferQueue({ job, onCancel }: { job: ActiveJob | null; onCancel: () => void }) {
  if (!job) {
    return (
      <div className="flex h-14 items-center px-3 text-[12px] text-muted">
        Transfer queue is empty. Select a source and destination, then Preview or Sync.
      </div>
    )
  }

  return (
    <div className="flex h-14 items-center gap-4 px-3 text-[12px]">
      <span className="w-16 shrink-0 font-mono text-[11px] text-muted">{job.jobId.slice(0, 8)}</span>

      <div className="min-w-0 flex-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div
            className={`h-full transition-[width] duration-300 ${job.finished ? 'bg-muted' : 'bg-accent'}`}
            style={{ width: `${Math.min(100, job.percent)}%` }}
          />
        </div>
        <div className="mt-1 truncate text-[11px] text-muted">
          {job.finished ? job.message : `${formatBytes(job.bytesTransferred)} · ${formatRate(job.bytesPerSecond)}`}
        </div>
      </div>

      <span className="w-10 shrink-0 text-right tabular-nums">{job.percent}%</span>

      {job.finished ? (
        <span className={`shrink-0 ${job.resumable ? 'text-warn' : 'text-accent'}`}>
          {job.resumable ? 'Interrupted — resumable' : 'Completed'}
        </span>
      ) : (
        <Button variant="danger" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  )
}
