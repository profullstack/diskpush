'use client'

import { ArrowLeft, ArrowRight, Eye, Trash2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
 *
 * They also say "Sync to" rather than only naming the destination. Without the
 * verb the pair read as a two-option destination picker, and the filled one
 * read as "currently selected" rather than "this is the button that starts the
 * transfer" -- which is what it has always actually done.
 */
function Direction({
  side,
  label,
  armed,
  busy,
  selectedCount,
  onClick,
}: {
  side: 'left' | 'right'
  label: string
  armed: boolean
  busy: boolean
  /** Ticked entries in the source pane. 0 means the whole directory. */
  selectedCount: number
  onClick: () => void
}) {
  const Arrow = side === 'right' ? ArrowRight : ArrowLeft
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={busy}
            className={cn(
              'focus-ring flex h-[68px] w-full flex-col items-center justify-center gap-1 rounded-xl px-1.5 transition-all active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
              armed
                ? 'elevation-armed bg-primary text-primary-foreground hover:bg-brand-lift'
                : 'border border-line-strong bg-secondary text-muted-foreground hover:border-primary/50 hover:text-foreground',
            )}
          />
        }
      >
        <Arrow className="size-[20px]" strokeWidth={2.25} />
        <span
          className={cn(
            'text-[8.5px] font-semibold uppercase leading-none tracking-[0.11em]',
            armed ? 'text-primary-foreground/70' : 'text-faint',
          )}
        >
          {armed && selectedCount > 0 ? `Send ${selectedCount}` : 'Sync to'}
        </span>
        <span className="w-full truncate text-center text-[11px] font-semibold leading-none">{label}</span>
      </TooltipTrigger>
      <TooltipContent>
        {/* Only on the armed button: the count is the *source* pane's, and
            the other button would make the other pane the source. */}
        {armed && selectedCount > 0
          ? `Copy the ${selectedCount} selected ${selectedCount === 1 ? 'entry' : 'entries'} into ${label}`
          : `Copy into ${label}, overwriting what differs`}
      </TooltipContent>
    </Tooltip>
  )
}

function RailAction({
  label,
  tooltip,
  icon,
  onClick,
  disabled,
  pressed,
  tone = 'neutral',
}: {
  label: string
  tooltip: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  tone?: 'neutral' | 'danger'
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={pressed}
            className={cn(
              'focus-ring flex h-[52px] w-full flex-col items-center justify-center gap-1.5 rounded-xl border text-[10.5px] font-medium transition-colors active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
              pressed
                ? 'border-destructive bg-destructive/15 text-destructive'
                : tone === 'danger'
                  ? 'border-line-strong text-muted-foreground hover:border-destructive/50 hover:text-destructive'
                  : 'border-line-strong text-muted-foreground hover:border-primary/50 hover:text-foreground',
            )}
          />
        }
      >
        {icon}
        {label}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export function TransferRail({
  direction,
  mirror,
  busy,
  selectedCount,
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
  /** Ticked entries in the source pane. 0 means the whole directory. */
  selectedCount: number
  leftLabel: string
  rightLabel: string
  onDirection: (direction: 'ltr' | 'rtl') => void
  onToggleMirror: () => void
  onPreview: () => void
  onRun: () => void
}) {
  return (
    // Every control in the rail is now one width and one corner radius. It
    // used to hold a 64px button with an xl radius above a 50px button with a
    // 10px radius, which is the sort of thing that reads as unfinished long
    // before anyone can say why.
    <div className="flex w-[116px] shrink-0 flex-col items-center justify-center gap-2 px-3">
      <Direction
        side="right"
        selectedCount={selectedCount}
        label={rightLabel}
        armed={direction === 'ltr'}
        busy={busy}
        onClick={() => {
          onDirection('ltr')
          onRun()
        }}
      />
      <Direction
        side="left"
        selectedCount={selectedCount}
        label={leftLabel}
        armed={direction === 'rtl'}
        busy={busy}
        onClick={() => {
          onDirection('rtl')
          onRun()
        }}
      />

      <div className="my-1 h-px w-8 bg-line-strong" />

      <RailAction
        label="Preview"
        tooltip="Show what would change, without transferring anything"
        icon={<Eye className="size-[17px]" />}
        onClick={onPreview}
        disabled={busy}
      />

      {/*
        Mirror is a MODE, not an action -- it arms deletion on the next
        transfer. It used to sit here in permanent destructive red at the same
        weight as Preview, which read as a button you press to delete things and
        made the most dangerous control the loudest thing on screen. Off, it is
        now as quiet as any other toggle; on, it is unmistakable, because that
        is the state actually worth shouting about.
      */}
      <RailAction
        label={mirror ? 'Mirror on' : 'Mirror'}
        tooltip="Make the destination match the source, deleting what the source does not have"
        icon={<Trash2 className="size-[17px]" />}
        onClick={onToggleMirror}
        pressed={mirror}
        tone="danger"
      />
    </div>
  )
}
