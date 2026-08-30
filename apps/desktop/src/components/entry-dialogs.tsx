'use client'

import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Asks for one name.
 *
 * Used by New folder, New file and Rename. They differ only in their words and
 * their starting value, and three near-identical dialogs would have drifted.
 */
export function NameDialog({
  open,
  title,
  action,
  initialValue = '',
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean
  title: string
  action: string
  initialValue?: string
  busy: boolean
  error: string | null
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)

  // Reopening for a different entry must not show the previous entry's name.
  useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  const trimmed = value.trim()
  const invalid =
    trimmed === '' || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!invalid && !busy) onSubmit(trimmed)
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-name">Name</Label>
            <Input
              id="entry-name"
              autoFocus
              value={value}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
            {/* Said before submitting rather than after failing, because the
                main process rejects these names and a round trip to learn so
                reads as a bug. */}
            {trimmed.includes('/') || trimmed.includes('\\') ? (
              <p className="text-[11.5px] text-warn">A name cannot contain a path separator.</p>
            ) : null}
          </div>
          {error ? <p className="selectable text-[11.5px] text-danger-ink">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || busy}>
              {busy ? 'Working…' : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Confirms a delete.
 *
 * Names the thing and says plainly that a folder takes its contents with it —
 * there is no trash on the far side of an SFTP connection.
 */
export function DeleteDialog({
  open,
  name,
  isDirectory,
  where,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean
  name: string
  isDirectory: boolean
  where: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-[16px] text-danger-ink" />
            Delete {isDirectory ? 'folder' : 'file'}?
          </DialogTitle>
          <DialogDescription>
            <span className="selectable font-medium text-foreground">{name}</span> on {where}
            {isDirectory ? ' and everything inside it' : ''} will be deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="selectable text-[11.5px] text-danger-ink">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
