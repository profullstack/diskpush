'use client'

import { ArrowLeft, ArrowRight, Eye, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The transfer controls, between the panes rather than in a toolbar.
 *
 * Direction is spatial here: you press the arrow pointing at where the files
 * should go, and the pane it points away from is the source. That is one
 * fewer thing to read than a "Source: LEFT" label, and it is the part of a
 * two-pane client people get wrong most often.
 */
export function TransferRail({
  direction,
  mirror,
  busy,
  onDirection,
  onToggleMirror,
  onPreview,
  onRun,
}: {
  direction: 'ltr' | 'rtl'
  mirror: boolean
  busy: boolean
  onDirection: (direction: 'ltr' | 'rtl') => void
  onToggleMirror: () => void
  onPreview: () => void
  onRun: () => void
}) {
  return (
    <div className="flex w-[92px] shrink-0 flex-col items-center justify-center gap-2.5 px-2">
      <button
        type="button"
        title="Sync left pane into right"
        onClick={() => {
          onDirection('ltr')
          onRun()
        }}
        disabled={busy}
        className={cn(
          'flex h-[62px] w-[76px] flex-col items-center justify-center gap-1.5 rounded-xl text-[11px] font-semibold transition-all disabled:opacity-40',
          direction === 'ltr'
            ? 'bg-gradient-to-b from-[#1a6dfd] to-[#0b52e0] text-white shadow-[0_4px_14px_-4px_#0b62fd99]'
            : 'border border-line-strong bg-secondary text-dim hover:border-[#2c3b56]',
        )}
      >
        <ArrowRight className="size-[22px]" strokeWidth={2} />
        Sync
      </button>

      <button
        type="button"
        title="Sync right pane into left"
        onClick={() => {
          onDirection('rtl')
          onRun()
        }}
        disabled={busy}
        className={cn(
          'flex h-[62px] w-[76px] flex-col items-center justify-center gap-1.5 rounded-xl text-[11px] font-semibold transition-all disabled:opacity-40',
          direction === 'rtl'
            ? 'bg-gradient-to-b from-[#1a6dfd] to-[#0b52e0] text-white shadow-[0_4px_14px_-4px_#0b62fd99]'
            : 'border border-line-strong bg-secondary text-dim hover:border-[#2c3b56]',
        )}
      >
        <ArrowLeft className="size-[22px]" strokeWidth={2} />
        Sync
      </button>

      <div className="my-1 h-px w-11 bg-line" />

      <button
        type="button"
        onClick={onPreview}
        disabled={busy}
        className="flex h-[54px] w-[76px] flex-col items-center justify-center gap-1 rounded-[10px] border border-line-strong text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
      >
        <Eye className="size-[18px]" />
        Preview
      </button>

      <button
        type="button"
        title="Make the destination match the source, deleting what the source does not have"
        onClick={onToggleMirror}
        className={cn(
          'flex h-[54px] w-[76px] flex-col items-center justify-center gap-1 rounded-[10px] border text-[10.5px] font-medium transition-colors',
          mirror
            ? 'border-destructive/60 bg-destructive/15 text-destructive'
            : 'border-[#4a2230] text-destructive/85 hover:bg-destructive/10',
        )}
      >
        <Trash2 className="size-[18px]" />
        Mirror
      </button>
    </div>
  )
}
