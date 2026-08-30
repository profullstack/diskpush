'use client'

import { useState } from 'react'
import { BookmarkPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SyncProfile } from '@/lib/api'

/**
 * Saved transfer setups, as a strip above the panes.
 *
 * A profile is a source, a destination and the options — the thing an SFTP
 * client calls a saved site. The pieces existed: the table, the CLI, and an
 * IPC channel. The channel had no handler and nothing in the window called
 * it, so the app could list profiles and delete them but never make one.
 *
 * Deliberately the same shape as the Fleet view's command strip: chips you
 * click to restore, an × to delete, and one control to save what is on screen.
 * Two lists of saved things that behaved differently would be two things to
 * learn.
 */
export function ProfileBar({
  profiles,
  routeLabel,
  busy,
  onLoad,
  onSave,
  onRemove,
}: {
  profiles: readonly SyncProfile[]
  /** What would be saved, e.g. `This computer → web-01`. Shown while naming. */
  routeLabel: string
  busy: boolean
  onLoad: (profile: SyncProfile) => void
  onSave: (name: string) => void
  onRemove: (id: string) => void
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const commit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave(trimmed)
    setName('')
    setNaming(false)
  }

  // Nothing saved and nothing being saved: no strip at all rather than an
  // empty bar explaining itself.
  if (profiles.length === 0 && !naming) {
    return (
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-4">
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={busy}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <BookmarkPlus className="size-3" />
          Save this pair
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-[30px] shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-1">
      <span className="mr-1 text-[11px] text-faint">Saved</span>

      {profiles.map((profile) => (
        <span
          key={profile.id}
          className="group/profile inline-flex items-center overflow-hidden rounded-md border border-line-strong"
        >
          <button
            type="button"
            title={`${describe(profile.source)} → ${describe(profile.destination)}${
              profile.options?.deleteMode && profile.options.deleteMode !== 'off' ? '  ·  deletes ON' : ''
            }`}
            onClick={() => onLoad(profile)}
            disabled={busy}
            className="focus-ring px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            {profile.name}
            {profile.options?.deleteMode && profile.options.deleteMode !== 'off' ? (
              // Worth a mark of its own. Loading a profile that turns Mirror
              // on should not be something you discover from the footer.
              <span className="ml-1 text-destructive">mirror</span>
            ) : null}
          </button>
          <button
            type="button"
            aria-label={`Delete the profile ${profile.name}`}
            title={`Delete the saved profile ${profile.name}`}
            onClick={() => onRemove(profile.id)}
            disabled={busy}
            className="focus-ring pr-1 text-faint opacity-0 transition-opacity hover:text-destructive group-hover/profile:opacity-100"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}

      {naming ? (
        <span className="inline-flex items-center gap-1">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
              if (event.key === 'Escape') {
                setNaming(false)
                setName('')
              }
            }}
            placeholder="profile name"
            className="h-6 w-[150px] text-[11.5px]"
          />
          <Button size="xs" onClick={commit} disabled={!name.trim()} className="text-[11px]">
            Save
          </Button>
          <span className="text-[10.5px] text-faint">{routeLabel}</span>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={busy}
          className="focus-ring inline-flex items-center gap-1 rounded-md border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <BookmarkPlus className="size-2.5" />
          Save this pair
        </button>
      )}
    </div>
  )
}

function describe(endpoint: SyncProfile['source']): string {
  if (endpoint.type === 'local') return endpoint.path
  return `${endpoint.host}:${endpoint.path}`
}
