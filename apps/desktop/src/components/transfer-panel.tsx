'use client'

import { useRef } from 'react'
import { ArrowRight, ChevronRight, CircleCheck, Trash2, TriangleAlert } from 'lucide-react'
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
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        initialFocus={cancelRef}
        className="max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 border-line-strong bg-popover p-0 [--dialog-pad:0px]"
      >
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-[18px] py-4">
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-danger-surface text-destructive">
            <TriangleAlert className="size-[17px]" />
          </span>
          <div className="min-w-0 text-left">
            <DialogTitle className="text-[14px]">Mirror</DialogTitle>
            <DialogDescription className="selectable mt-0.5 truncate font-[family-name:var(--font-mono)] text-[11.5px]">
              {route}
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* One scrolling body, so a preview with a long delete list keeps its
            header and its confirm buttons on screen instead of pushing them
            past the bottom of the window. */}
        <div className="min-h-0 overflow-y-auto">
          {!preview ? (
            <div className="flex items-center gap-2.5 px-[18px] py-8 text-[12.5px] text-muted-foreground">
              <span className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-primary" />
              Scanning both sides…
            </div>
          ) : !preview.ok ? (
            <p className="selectable px-[18px] py-8 text-[12.5px] text-destructive">{preview.message}</p>
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
                    <div className={cn('numeric text-[19px] font-medium', tone)}>{value.toLocaleString()}</div>
                    <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.07em] text-faint">{label}</div>
                  </div>
                ))}
              </div>

              <div className="px-[18px] pt-3.5">
                {deletes.length > 0 ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-danger-line bg-danger-surface px-3 py-2.5 text-[12.5px] text-danger-ink">
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
                  {/* max-, not a fixed height: two doomed files used to sit at
                      the top of a 210px well of empty space. */}
                  <ScrollArea className="mt-2 max-h-[210px] rounded-lg border border-line bg-background py-1">
                    {deletes.map((path) => (
                      <div
                        key={path}
                        className="selectable numeric flex h-[27px] items-center gap-2.5 px-3 text-[11.5px] text-danger-ink"
                      >
                        <span className="shrink-0 text-destructive/70">−</span>
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

              <details className="group px-[18px] pb-4 pt-3">
                <summary className="focus-ring inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-[10.5px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-muted-foreground">
                  <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                  Effective rsync command
                </summary>
                <pre className="selectable numeric mt-2 overflow-x-auto rounded-lg border border-line bg-background p-2.5 text-[11px] text-muted-foreground">
                  {preview.command}
                </pre>
                {preview.control ? (
                  <pre className="selectable numeric mt-1 overflow-x-auto rounded-lg border border-line bg-background p-2.5 text-[11px] text-faint">
                    {`# control session: ${preview.control}`}
                  </pre>
                ) : null}
              </details>
            </>
          )}
        </div>

        <DialogFooter className="items-center border-t border-line px-[18px] py-3.5 sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
            <Checkbox checked={trust} onCheckedChange={(next) => onTrustChange(next === true)} />
            Trust this pair from now on
          </label>
          <div className="flex gap-2">
            {/*
              Focus opens on Cancel, not on the confirm and not on the trust
              checkbox it used to land on. This dialog's whole job is to make
              an irreversible delete deliberate, so a stray Enter or Space has
              to hit the harmless control.
            */}
            <Button ref={cancelRef} variant="outline" onClick={onCancel} className="h-[33px] border-line-strong">
              Cancel
            </Button>
            <Button
              onClick={onConfirm}
              disabled={!preview?.ok}
              className={cn('h-[33px] font-semibold', deletes.length > 0 && 'bg-danger-solid text-white hover:bg-danger-solid-lift')}
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
export function TransferBand({
  job,
  route,
  mirror,
  onCancel,
}: {
  job: ActiveJob | null
  route: string
  mirror: boolean
  onCancel: () => void
}) {
  /*
   * Idle used to be 74px of "Nothing transferring. Choose a direction and
   * press Sync." -- the tallest band in the window, spent telling you that
   * nothing was happening, which you could already see. It is now a slim
   * status strip that says what the next run would actually do, so the space
   * carries information rather than an apology.
   */
  if (!job) {
    return (
      <div className="flex h-[38px] shrink-0 items-center gap-2.5 border-t border-line bg-chrome px-4 text-[11.5px]">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-secondary">
          <ArrowRight className="size-3 text-faint" />
        </span>
        <span className="text-muted-foreground">Ready</span>
        <span className="text-line-strong">·</span>
        <span className="selectable numeric min-w-0 truncate text-dim">{route}</span>
        {mirror ? (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-danger-surface px-1.5 py-0.5 text-[10px] font-medium text-danger-ink">
            <Trash2 className="size-3" />
            Deletes armed
          </span>
        ) : null}
      </div>
    )
  }

  const remaining =
    job.percent > 0 && job.percent < 100 && job.elapsedSeconds > 0
      ? (job.elapsedSeconds / job.percent) * (100 - job.percent)
      : null
  const failed = job.finished && job.resumable
  const done = job.finished && !job.resumable

  return (
    <div className="shrink-0 border-t border-line bg-chrome px-4 pb-3 pt-2.5">
      <div className="mb-2 flex items-center gap-3">
        <span className="flex shrink-0 items-center gap-2 text-[12px] font-semibold">
          <span
            className={cn(
              'flex size-[18px] items-center justify-center rounded-full',
              done ? 'bg-ok/15 text-ok' : failed ? 'bg-danger-surface text-destructive' : 'bg-primary/15 text-primary',
            )}
          >
            {done ? (
              <CircleCheck className="size-3.5" />
            ) : failed ? (
              <TriangleAlert className="size-3" />
            ) : (
              <ArrowRight className="size-3" />
            )}
          </span>
          {done ? 'Finished' : failed ? 'Interrupted' : 'Transferring'}
        </span>
        <span className="selectable numeric min-w-0 truncate text-[11.5px] text-muted-foreground">{route}</span>

        <div className="ml-auto flex shrink-0 items-center gap-4 text-[11.5px] text-muted-foreground">
          <span className="numeric text-foreground">{formatBytes(job.bytesTransferred)}</span>
          <span className="numeric text-foreground">{formatRate(job.bytesPerSecond)}</span>
          {remaining !== null ? (
            <span>
              ETA <span className="numeric text-foreground">{formatDuration(remaining)}</span>
            </span>
          ) : null}
          {job.finished ? null : (
            <Button
              variant="outline"
              onClick={onCancel}
              className="h-[26px] border-danger-line px-2.5 text-[11px] text-destructive hover:bg-danger-surface hover:text-destructive"
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/*
        The track and the indicator are addressed by slot. This used to set
        `h-[5px] bg-accent` on the Progress ROOT -- a flex wrapper, not the bar
        -- and recolour `[&>div]` on finish, which is the track rather than the
        fill, so a completed transfer turned the whole bar green whatever the
        percentage was.
      */}
      <Progress
        value={job.percent}
        className={cn(
          'w-full [&_[data-slot=progress-track]]:h-[6px] [&_[data-slot=progress-track]]:bg-accent',
          done && '[&_[data-slot=progress-indicator]]:bg-ok',
          failed && '[&_[data-slot=progress-indicator]]:bg-destructive',
        )}
      />

      <div className="mt-2 flex items-center gap-2.5 text-[11px] text-muted-foreground">
        <span className={cn('numeric font-medium', done ? 'text-ok' : failed ? 'text-destructive' : 'text-primary')}>
          {job.percent}%
        </span>
        <span className="selectable numeric min-w-0 truncate">
          {job.finished ? job.message : job.currentFile || 'scanning…'}
        </span>
        <span className="numeric ml-auto shrink-0">{job.files.toLocaleString()} files</span>
      </div>
    </div>
  )
}
