'use client'

import { ArrowLeft, ArrowRight, Eye, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The transfer controls, between the panes rather than in a toolbar.
 *
 * Direction is spatial: you press the arrow pointing at where the files should
 * go, and the pane it points away from is the source. That is one fewer thing
 * to read than a "Source: LEFT" label, and it is the part of a two-pane client
 * people get wrong most often.
 *
 * Both buttons used to be labelled "Sync", which undid exactly that: two
 * identical words, and only a small arrow between you and overwriting the
 * wrong side. They now name the destination, so the label says where the files
 * land -- the one fact worth being sure of before pressing it.
 */
export function TransferRail({
  direction,
  mirror,
  busy,
  leftLabel,
  rightLabel,
  onDirection,
  onToggleMirror,
  onPreview,
  onRun,
}: {
  direction: 'ltr' | 'rtl'
  mirror: boolean
  busy: boolean
  leftLabel: string
  rightLabel: string
  onDirection: (direction: 'ltr' | 'rtl') => void
  onToggleMirror: () => void
  onPreview: () => void
  onRun: () => void
}) {
  const action =
    'flex w-[84px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-all disabled:opacity-40'
  const armed =
    'bg-gradient-to-b from-[#1a6dfd] to-[#0b52e0] text-white shadow-[0_4px_14px_-4px_#0b62fd99]'
  const idle = 'border border-border bg-secondary text-muted-foreground hover:border-ring/60 hover:text-foreground'

  return (
    <div className="flex w-[104px] shrink-0 flex-col items-center justify-center gap-2 px-2">
      <button
        type="button"
        title={`Copy from ${leftLabel} into ${rightLabel}`}
        onClick={() => {
          onDirection('ltr')
          onRun()
        }}
        disabled={busy}
        className={cn(action, 'h-[64px]', direction === 'ltr' ? armed : idle)}
      >
        <ArrowRight className="size-[22px]" strokeWidth={2} />
        <span className="max-w-[74px] truncate font-medium opacity-90">to {rightLabel}</span>
      </button>

      <button
        type="button"
        title={`Copy from ${rightLabel} into ${leftLabel}`}
        onClick={() => {
          onDirection('rtl')
          onRun()
        }}
        disabled={busy}
        className={cn(action, 'h-[64px]', direction === 'rtl' ? armed : idle)}
      >
        <ArrowLeft className="size-[22px]" strokeWidth={2} />
        <span className="max-w-[74px] truncate font-medium opacity-90">to {leftLabel}</span>
      </button>

      <div className="my-1 h-px w-11 bg-border" />

      <button
        type="button"
        title="Show what would change, without transferring anything"
        onClick={onPreview}
        disabled={busy}
        className="flex h-[50px] w-[84px] flex-col items-center justify-center gap-1 rounded-[10px] border border-border text-[10.5px] font-medium text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground disabled:opacity-40"
      >
        <Eye className="size-[18px]" />
        Preview
      </button>

      {/*
        Mirror is a MODE, not an action -- it arms deletion on the next
        transfer. It used to sit here in permanent destructive red at the same
        weight as Preview, which read as a button you press to delete things and
        made the most dangerous control the loudest thing on screen. Off, it is
        now as quiet as any other toggle; on, it is unmistakable, because that
        is the state actually worth shouting about.
      */}
      <button
        type="button"
        aria-pressed={mirror}
        title="Make the destination match the source, deleting what the source does not have"
        onClick={onToggleMirror}
        className={cn(
          'flex h-[50px] w-[84px] flex-col items-center justify-center gap-1 rounded-[10px] border text-[10.5px] font-medium transition-colors',
          mirror
            ? 'border-destructive bg-destructive/15 text-destructive'
            : 'border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive',
        )}
      >
        <Trash2 className="size-[18px]" />
        Mirror{mirror ? ' on' : ''}
      </button>
    </div>
  )
}
