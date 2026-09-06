'use client'

import { useEffect, useRef, useState } from 'react'
import { AppWindow, CircleAlert, Terminal } from 'lucide-react'
import { api, unwrap, type HandlerList } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** The system default, as a row. It is always offered, even with no list. */
const SYSTEM_DEFAULT = '__system__'

/**
 * Open with.
 *
 * Double-clicking a file should just open it, and mostly the system default is
 * right. This is for the times it is not: the default is preselected and Open
 * is one keystroke away, so the common case costs nothing, but the list is
 * right there when you want a different application.
 */
export function OpenWithDialog({
  open,
  path,
  name,
  onClose,
}: {
  open: boolean
  path: string | null
  name: string | null
  onClose: () => void
}) {
  const [list, setList] = useState<HandlerList | null>(null)
  const [chosen, setChosen] = useState<string>(SYSTEM_DEFAULT)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const openRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open || !path) return
    setList(null)
    setError(null)
    setChosen(SYSTEM_DEFAULT)
    let current = true
    void (async () => {
      try {
        const result = await unwrap(api()?.fs.handlers(path))
        if (!current) return
        setList(result)
        // The system default row stays selected: it is what the machine would
        // do, and preselecting a named application would quietly change the
        // answer for anyone who just presses Enter.
      } catch (caught) {
        if (current) setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => {
      current = false
    }
  }, [open, path])

  const launch = async () => {
    if (!path) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(api()?.fs.openWith(path, chosen === SYSTEM_DEFAULT ? null : chosen))
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const rows = list?.handlers ?? []

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent initialFocus={openRef} className="max-w-md border-line-strong bg-popover">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Open with</DialogTitle>
          <DialogDescription className="selectable truncate font-[family-name:var(--font-mono)] text-[11.5px]">
            {name ?? path}
            {list?.contentType ? <span className="text-faint"> · {list.contentType}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0">
          {!list && !error ? (
            <div className="flex items-center gap-2.5 py-4 text-[12.5px] text-muted-foreground">
              <span className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-primary" />
              Looking for applications…
            </div>
          ) : (
            /*
              `max-h` on a ScrollArea root does not clip: its viewport is
              `size-full`, so with no definite height it grows to fit and the
              last rows are cut off by the dialog with no way to reach them.
              The bounded flex column is what gives the viewport a height.
            */
            <div className="flex max-h-[240px] flex-col overflow-hidden">
              <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-0.5 pr-1">
                <HandlerRow
                  label="System default"
                  detail="Whatever this computer already uses"
                  selected={chosen === SYSTEM_DEFAULT}
                  onSelect={() => setChosen(SYSTEM_DEFAULT)}
                />
                {rows.map((handler) => (
                  <HandlerRow
                    key={handler.id}
                    label={handler.name}
                    detail={handler.isDefault ? 'The current default' : handler.id.replace(/\.desktop$/, '')}
                    terminal={handler.terminal}
                    selected={chosen === handler.id}
                    onSelect={() => setChosen(handler.id)}
                  />
                ))}
              </div>
              </ScrollArea>
            </div>
          )}

          {list?.note ? <p className="pt-2.5 text-[11.5px] text-muted-foreground">{list.note}</p> : null}
          {error ? (
            <p className="selectable flex items-start gap-2 pt-2.5 text-[11.5px] text-destructive">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-end">
          <Button variant="outline" onClick={onClose} className="h-[33px] border-line-strong">
            Cancel
          </Button>
          <Button ref={openRef} onClick={() => void launch()} disabled={busy} className="h-[33px] font-semibold">
            {busy ? 'Opening…' : 'Open'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HandlerRow({
  label,
  detail,
  terminal,
  selected,
  onSelect,
}: {
  label: string
  detail: string
  terminal?: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'focus-ring flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
        selected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-secondary',
      )}
    >
      <span
        className={cn(
          'flex size-[26px] shrink-0 items-center justify-center rounded-md',
          selected ? 'bg-primary/15 text-primary' : 'bg-secondary text-faint',
        )}
      >
        {terminal ? <Terminal className="size-[14px]" /> : <AppWindow className="size-[14px]" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-foreground">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {/*
            A terminal application launched from a file manager usually flashes
            and exits, so it says so rather than looking like a broken choice.
          */}
          {terminal ? 'Runs in a terminal' : detail}
        </span>
      </span>
    </button>
  )
}
