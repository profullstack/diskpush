'use client'

import { ArrowRight, Trash2, TriangleAlert } from 'lucide-react'
import type { PreviewResult } from '@/lib/api'
import { formatBytes, formatDuration, formatRate } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export type ActiveJob = {
  jobId: string
  percent: number
  bytesTransferred: number
  bytesPerSecond: number
  files: number
  currentFile: string
  elapsedSeconds: number
  finished: boolean
  resumable: boolean
  message: string
}

/**
 * The delete preview.
 *
 * Every proposed deletion is listed rather than summarised: "87 files" is not
 * something anyone can consent to. The confirm button says what it does.
 */
export function MirrorPreviewDialog({
  preview,
  open,
  route,
  trust,
  onTrustChange,
  onCancel,
  onConfirm,
}: {
  preview: PreviewResult | null
  open: boolean
  route: string
  trust: boolean
  onTrustChange: (value: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const deletes = preview?.deletes ?? []
  const summary = preview?.summary

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-2xl gap-0 border-line-strong bg-popover p-0">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-[18px] py-4">
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-[#2a1620] text-destructive">
            <TriangleAlert className="size-[17px]" />
          </span>
          <div className="min-w-0 text-left">
            <DialogTitle className="text-[14px]">Mirror</DialogTitle>
            <DialogDescription className="selectable mt-0.5 truncate font-[family-name:var(--font-mono)] text-[11.5px]">
              {route}
            </DialogDescription>
          </div>
        </DialogHeader>

        {!preview ? (
          <p className="px-[18px] py-6 text-muted-foreground">Scanning…</p>
        ) : !preview.ok ? (
          <p className="selectable px-[18px] py-6 text-[12.5px] text-destructive">{preview.message}</p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-px border-b border-line bg-line">
              {(
                [
                  ['Add', summary?.add ?? 0, 'text-ok'],
                  ['Update', summary?.update ?? 0, 'text-primary'],
                  ['Unchanged', summary?.unchanged ?? 0, 'text-muted-foreground'],
                  ['Delete', deletes.length, 'text-destructive'],
                ] as const
              ).map(([label, value, tone]) => (
                <div key={label} className="bg-popover px-4 py-3">
                  <div className={cn('font-[family-name:var(--font-mono)] text-[19px] font-medium', tone)}>
                    {value.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.07em] text-faint">{label}</div>
                </div>
              ))}
            </div>

            <div className="px-[18px] pt-3.5">
              {deletes.length > 0 ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-[#45202e] bg-[#1c1119] px-3 py-2.5 text-[12.5px] text-[#fca5a5]">
                  <Trash2 className="size-4 shrink-0" />
                  <span>
                    <strong className="font-semibold text-destructive">
                      {deletes.length.toLocaleString()} file{deletes.length === 1 ? '' : 's'}
                    </strong>{' '}
                    at the destination will be deleted. This cannot be undone.
                  </span>
                </div>
              ) : (
                <div className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12.5px] text-muted-foreground">
                  Nothing at the destination would be deleted.
                </div>
              )}
            </div>

            {deletes.length > 0 ? (
              <div className="px-[18px] pt-3">
                <div className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Files to be deleted</div>
                <ScrollArea className="mt-2 h-[210px] rounded-lg border border-line bg-background">
                  {deletes.map((path) => (
                    <div
                      key={path}
                      className="selectable flex h-[27px] items-center gap-2.5 px-3 font-[family-name:var(--font-mono)] text-[11.5px] text-[#d4a0a0]"
                    >
                      <span className="text-[#7f3b47]">−</span>
                      <span className="truncate">{path}</span>
                    </div>
                  ))}
                </ScrollArea>
              </div>
            ) : null}

            {preview.warnings.map((warning) => (
              <p key={warning} className="selectable px-[18px] pt-3 text-[11.5px] text-warn">
                {warning}
              </p>
            ))}

            <details className="px-[18px] pt-3">
              <summary className="cursor-pointer text-[10.5px] uppercase tracking-[0.08em] text-faint">
                Effective rsync command
              </summary>
              <pre className="selectable mt-2 overflow-x-auto rounded-lg border border-line bg-background p-2.5 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
                {preview.command}
              </pre>
              {preview.control ? (
                <pre className="selectable mt-1 overflow-x-auto rounded-lg border border-line bg-background p-2.5 font-[family-name:var(--font-mono)] text-[11px] text-faint">
                  {`# control session: ${preview.control}`}
                </pre>
              ) : null}
            </details>
          </>
        )}

        <DialogFooter className="mt-3.5 items-center border-t border-line px-[18px] py-3.5 sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
            <Checkbox checked={trust} onCheckedChange={(next) => onTrustChange(next === true)} />
            Trust this pair from now on
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel} className="h-[33px] border-line-strong">
              Cancel
            </Button>
            <Button
              onClick={onConfirm}
              disabled={!preview?.ok}
              className={cn('h-[33px] font-semibold', deletes.length > 0 && 'bg-[#b03a4a] text-white hover:bg-[#c04355]')}
            >
              {deletes.length > 0 ? `Delete ${deletes.length} and mirror` : 'Mirror'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The transfer band.
 *
 * Promoted out of the footer: with twenty thousand files going past, an
 * aggregate percentage says the job is alive but not what it is doing, so the
 * file currently moving is on screen too.
 */
export function TransferBand({ job, route, onCancel }: { job: ActiveJob | null; route: string; onCancel: () => void }) {
  if (!job) {
    return (
      <div className="flex h-[74px] items-center gap-3 border-t border-line bg-chrome px-4 text-[12px] text-muted-foreground">
        <ArrowRight className="size-4 text-faint" />
        Nothing transferring. Choose a direction and press Sync.
      </div>
    )
  }

  const remaining =
    job.percent > 0 && job.percent < 100 && job.elapsedSeconds > 0
      ? (job.elapsedSeconds / job.percent) * (100 - job.percent)
      : null

  return (
    <div className="border-t border-line bg-chrome px-4 pb-2.5 pt-3">
      <div className="mb-2 flex items-center gap-3">
        <span className="flex items-center gap-2 text-[12px] font-semibold">
          <ArrowRight className={cn('size-3.5', job.finished ? 'text-muted-foreground' : 'text-primary')} />
          {job.finished ? (job.resumable ? 'Interrupted' : 'Finished') : 'Transferring'}
        </span>
        <span className="selectable font-[family-name:var(--font-mono)] text-[11.5px] text-muted-foreground">{route}</span>

        <div className="ml-auto flex items-center gap-3.5 font-[family-name:var(--font-mono)] text-[11.5px] text-muted-foreground">
          <span>
            <span className="text-foreground">{formatBytes(job.bytesTransferred)}</span>
          </span>
          <span>
            <span className="text-foreground">{formatRate(job.bytesPerSecond)}</span>
          </span>
          {remaining !== null ? (
            <span>
              ETA <span className="text-foreground">{formatDuration(remaining)}</span>
            </span>
          ) : null}
          {job.finished ? null : (
            <Button variant="outline" onClick={onCancel} className="h-[26px] border-[#3a2430] px-2.5 text-[11px] text-destructive">
              Cancel
            </Button>
          )}
        </div>
      </div>

      <Progress
        value={job.percent}
        className={cn('h-[5px] bg-[#16203a]', job.finished && !job.resumable && '[&>div]:bg-ok')}
      />

      <div className="mt-2 flex items-center gap-2.5 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
        <span className={cn(job.finished ? 'text-muted-foreground' : 'text-primary')}>{job.percent}%</span>
        <span className="selectable truncate">{job.finished ? job.message : job.currentFile || 'scanning…'}</span>
        <span className="ml-auto shrink-0">{job.files.toLocaleString()} files</span>
      </div>
    </div>
  )
}
