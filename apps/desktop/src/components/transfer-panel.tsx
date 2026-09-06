'use client'

import { useEffect, useRef } from 'react'
import { ArrowRight, ChevronRight, CircleCheck, Trash2, TriangleAlert } from 'lucide-react'
import type { PreviewProgress, PreviewResult } from '@/lib/api'
import { formatBytes, formatDuration, formatRate } from '@/lib/format'
import { Button } from '@/components/ui/button'
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
 * What the scan panel shows before rsync has said anything.
 *
 * A zeroed progress rather than an absent one, so the panel has the same shape
 * from the first frame and does not rearrange itself once the first event
 * lands.
 */
const EMPTY_PROGRESS: PreviewProgress = {
  checked: 0,
  total: 0,
  changes: 0,
  deletes: 0,
  currentPath: '',
  elapsedSeconds: 0,
}

/**
 * Live progress while both sides are being compared.
 *
 * This used to be a spinner and the words "Scanning both sides...", which is
 * all a person saw for however long a full scan of two trees takes -- minutes
 * over a WAN. A scan that is working and a scan that has wedged looked
 * identical, so every slow preview read as a hang. It now shows rsync's own
 * counters, so the panel moves whenever the scan does.
 *
 * `total` grows during the run, because rsync builds its file list
 * incrementally. The bar is therefore explicitly an estimate, and the counts
 * beside it are the honest numbers.
 */
function ScanProgress({ progress, onCancel }: { progress: PreviewProgress; onCancel: () => void }) {
  const { checked, total, changes, deletes, currentPath, elapsedSeconds } = progress
  const percent = total > 0 ? Math.min(100, Math.round((checked / total) * 100)) : 0

  return (
    <div className="px-[18px] py-6">
      <div className="flex items-center gap-2.5">
        <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-primary" />
        <span className="text-[12.5px] text-foreground">Comparing both sides</span>
        <span className="numeric ml-auto shrink-0 text-[11.5px] text-muted-foreground">
          {formatDuration(elapsedSeconds)}
        </span>
      </div>

      <Progress
        value={percent}
        className="mt-3 w-full [&_[data-slot=progress-track]]:h-[6px] [&_[data-slot=progress-track]]:bg-accent"
      />

      <div className="mt-2.5 flex items-center gap-4 text-[11.5px] text-muted-foreground">
        <span>
          <span className="numeric text-foreground">{checked.toLocaleString()}</span>
          {total > 0 ? <> of about <span className="numeric text-foreground">{total.toLocaleString()}</span></> : null}{' '}
          compared
        </span>
        <span>
          <span className="numeric text-foreground">{changes.toLocaleString()}</span> to change
        </span>
        {deletes > 0 ? (
          <span className="text-danger-ink">
            <span className="numeric font-medium text-destructive">{deletes.toLocaleString()}</span> to delete
          </span>
        ) : null}
      </div>

      {/*
        The path currently being compared. Without it a stalled scan and a slow
        one still look the same, because the counters can sit still for a long
        time on one large directory.
      */}
      <p className="selectable numeric mt-2.5 h-[15px] truncate text-[11px] text-faint">{currentPath || 'building the file list…'}</p>

      {/*
        Stopping is a real stop. Closing the dialog used to hide it and leave
        the dry run to finish into a window nobody was looking at, which is how
        a mistyped path cost you a full scan you could not interrupt.
      */}
      <Button variant="outline" onClick={onCancel} className="mt-4 h-[30px] border-line-strong text-[12px]">
        Stop scanning
      </Button>
    </div>
  )
}

/**
 * The delete preview.
 *
 * Every proposed deletion is listed rather than summarised: "87 files" is not
 * something anyone can consent to. Past PREVIEW_DELETE_LIMIT the enumeration
 * stops and says so, because a first mirror into an empty destination proposes
 * hundreds of thousands and a DOM node each is what froze the window. The
 * count on the confirm button is always the true one.
 */
export function TransferPreviewDialog({
  preview,
  progress,
  open,
  route,
  mirror,
  selectionCount,
  onCancel,
  onStopScan,
  onConfirm,
}: {
  preview: PreviewResult | null
  progress: PreviewProgress | null
  open: boolean
  route: string
  /** Deletes are armed. Changes what this dialog is for, not only its wording. */
  mirror: boolean
  /** Entries ticked in the source pane. 0 means the whole folder. */
  selectionCount: number
  onCancel: () => void
  onStopScan: () => void
  onConfirm: () => void
}) {
  const deletes = preview?.deletes ?? []
  const deleteTotal = preview?.deleteTotal ?? 0
  const hidden = Math.max(0, deleteTotal - deletes.length)
  // Additions and updates: what a plain sync actually moves. Deletions are
  // counted separately, on the button that arms them.
  const changeTotal = (preview?.summary.add ?? 0) + (preview?.summary.update ?? 0)
  const summary = preview?.summary
  const cancelRef = useRef<HTMLButtonElement>(null)

  /*
   * Focus lands on Cancel the moment the result does.
   *
   * `initialFocus` alone stopped being enough once the footer waits for the
   * scan: at open time there is no Cancel button to focus, so when the delete
   * list finally appeared the focus was still on the dialog and the next Enter
   * could reach the confirm. This dialog's whole job is to make an
   * irreversible delete deliberate.
   */
  useEffect(() => {
    if (preview) cancelRef.current?.focus()
  }, [preview])

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        initialFocus={cancelRef}
        className="max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 border-line-strong bg-popover p-0 [--dialog-pad:0px]"
      >
        {/*
          The header says which of the two things this is. Every manual
          transfer comes through here now, not only a mirror, and a plain sync
          wearing a red warning triangle and the word "Mirror" would be its own
          kind of wrong.
        */}
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-[18px] py-4">
          <span
            className={cn(
              'flex size-[30px] shrink-0 items-center justify-center rounded-lg',
              mirror ? 'bg-danger-surface text-destructive' : 'bg-primary/15 text-primary',
            )}
          >
            {mirror ? <TriangleAlert className="size-[17px]" /> : <ArrowRight className="size-[17px]" />}
          </span>
          <div className="min-w-0 text-left">
            <DialogTitle className="text-[14px]">{mirror ? 'Mirror' : 'Sync'}</DialogTitle>
            <DialogDescription className="selectable mt-0.5 truncate font-[family-name:var(--font-mono)] text-[11.5px]">
              {route}
            </DialogDescription>
          </div>
          {/*
            The scope, stated up front. Two ticked folders that turn into forty
            thousand files is the failure this dialog exists to catch, and the
            counts below only ever say how many, never how many of what was
            asked for.
          */}
          <span
            className={cn(
              'ml-auto shrink-0 rounded-md px-2 py-1 text-[10.5px] font-medium',
              selectionCount > 0 ? 'bg-primary/12 text-primary' : 'bg-secondary text-muted-foreground',
            )}
          >
            {selectionCount > 0
              ? `${selectionCount.toLocaleString()} selected item${selectionCount === 1 ? '' : 's'}`
              : 'Whole folder'}
          </span>
        </DialogHeader>

        {/* One scrolling body, so a preview with a long delete list keeps its
            header and its confirm buttons on screen instead of pushing them
            past the bottom of the window. */}
        <div className="min-h-0 overflow-y-auto">
          {!preview ? (
            <ScanProgress progress={progress ?? EMPTY_PROGRESS} onCancel={onStopScan} />
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
                    ['Delete', deleteTotal, 'text-destructive'],
                  ] as const
                ).map(([label, value, tone]) => (
                  <div key={label} className="bg-popover px-4 py-3">
                    <div className={cn('numeric text-[19px] font-medium', tone)}>{value.toLocaleString()}</div>
                    <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.07em] text-faint">{label}</div>
                  </div>
                ))}
              </div>

              <div className="px-[18px] pt-3.5">
                {deleteTotal > 0 ? (
                  <div className="flex items-center gap-2.5 rounded-lg border border-danger-line bg-danger-surface px-3 py-2.5 text-[12.5px] text-danger-ink">
                    <Trash2 className="size-4 shrink-0" />
                    <span>
                      <strong className="font-semibold text-destructive">
                        {deleteTotal.toLocaleString()} file{deleteTotal === 1 ? '' : 's'}
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

              {deleteTotal > 0 ? (
                <div className="px-[18px] pt-3">
                  <div className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Files to be deleted</div>
                  {/* max-, not a fixed height: two doomed files used to sit at
                      the top of a 210px well of empty space. */}
                  {/*
                    The scroll box needs a definite height, which `max-h` on the
                    ScrollArea root alone never gave it: its viewport is
                    `size-full`, so it grew to fit and the rows printed straight
                    over the disclosure below. Every other ScrollArea in the app
                    is `min-h-0 flex-1` inside a flex column, and so is this one.
                  */}
                  <div className="mt-2 flex max-h-[210px] flex-col overflow-hidden rounded-lg border border-line bg-background py-1">
                    <ScrollArea className="min-h-0 flex-1">
                      {deletes.map((path) => (
                        <div
                          key={path}
                          className="selectable numeric flex h-[27px] items-center gap-2.5 px-3 text-[11.5px] text-danger-ink"
                        >
                          <span className="shrink-0 text-destructive/70">−</span>
                          <span className="truncate">{path}</span>
                        </div>
                      ))}
                      {hidden > 0 ? (
                        <div className="flex h-[27px] items-center px-3 text-[11.5px] font-medium text-muted-foreground">
                          …and {hidden.toLocaleString()} more, not listed
                        </div>
                      ) : null}
                    </ScrollArea>
                  </div>
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

        {/*
          No confirm controls while there is nothing to confirm. The footer used
          to render throughout the scan, so a full-strength Mirror button sat
          under the spinner offering to run a mirror whose delete list did not
          exist yet -- inert, which reads as a control that ignores you.

          There is no "trust this pair from now on" in here any more either. It
          set a piece of renderer state that nothing read, and it could not have
          worked if it were wired: saveProfile hard-codes `trustDeletes: false`
          on purpose, because unattended mirroring is the one way a delete list
          runs with nobody looking at it. A checkbox offering to skip a
          confirmation that is deliberately never skipped is worse than none.
        */}
        {preview ? (
          <DialogFooter className="items-center border-t border-line px-[18px] py-3.5 sm:justify-end">
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
                disabled={!preview?.ok || (changeTotal === 0 && deleteTotal === 0)}
                className={cn('h-[33px] font-semibold', deleteTotal > 0 && 'bg-danger-solid text-white hover:bg-danger-solid-lift')}
              >
                {deleteTotal > 0
                  ? `Delete ${deleteTotal.toLocaleString()} and mirror`
                  : mirror
                    ? 'Mirror'
                    : changeTotal > 0
                      ? `Sync ${changeTotal.toLocaleString()} file${changeTotal === 1 ? '' : 's'}`
                      : 'Nothing to sync'}
              </Button>
            </div>
          </DialogFooter>
        ) : null}
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
