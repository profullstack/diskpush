'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { File, Folder } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api'
import { listingPath, splitForCompletion, suggestions, tabComplete, type CompletionEntry, type Suggestion } from '@/lib/path-complete'

/**
 * A path box that completes as you type, like a shell: `~/pro` offers
 * `~/projects/`, `/ho` offers `/home/`. Tab completes the shared prefix (or the
 * one match), arrows pick, Enter or a click takes one; taking a folder keeps
 * the list open on its contents. Lists this machine, or a server over SFTP.
 */

/** Where to list: this machine, or a saved server. */
export type PathSource = { kind: 'local' } | { kind: 'remote'; connectionId: string }

type Props = {
  value: string
  onChange: (value: string) => void
  source: PathSource | null
  placeholder?: string
  className?: string
  'aria-label'?: string
}

// One listing per directory per source, for a little while: typing `~/pro`, `~/proj`
// and `~/proje` reads `~/` once, not three times over SSH.
const cache = new Map<string, { at: number; entries: CompletionEntry[] }>()
const CACHE_MS = 30_000

async function listDir(source: PathSource, dir: string): Promise<CompletionEntry[]> {
  const side = source.kind === 'local' ? 'local' : 'remote'
  const path = listingPath(dir, side)
  const key = `${source.kind === 'local' ? 'local' : source.connectionId}\u0000${path}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries
  const result = source.kind === 'local' ? await unwrap(api()?.fs.listLocal(path)) : await unwrap(api()?.fs.listRemote(source.connectionId, path))
  const entries = (result?.entries ?? []) as CompletionEntry[]
  cache.set(key, { at: Date.now(), entries })
  return entries
}

export function PathInput({ value, onChange, source, placeholder, className, ...rest }: Props) {
  const [entries, setEntries] = useState<CompletionEntry[]>([])
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const listId = useId()
  const requested = useRef('')

  const dir = splitForCompletion(value).dir
  const sourceKey = source ? (source.kind === 'local' ? 'local' : source.connectionId) : ''

  // Read the directory being typed in, after a short pause, only while the box has focus.
  useEffect(() => {
    if (!source || !focused) return
    const want = `${sourceKey}\u0000${dir}`
    requested.current = want
    const timer = setTimeout(() => {
      listDir(source, dir)
        .then((list) => {
          if (requested.current === want) setEntries(list)
        })
        .catch(() => {
          if (requested.current === want) setEntries([])
        })
    }, 120)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, dir, focused])

  const matches = useMemo(() => suggestions(value, entries), [value, entries])
  const visible = open && focused && matches.length > 0 && !(matches.length === 1 && matches[0]!.value === value)

  useEffect(() => setHighlight(-1), [value])

  const take = (s: Suggestion) => {
    onChange(s.value)
    // Into a folder: keep going. A file ends the path.
    setOpen(s.isDirectory)
    setHighlight(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      if (visible && highlight >= 0) {
        e.preventDefault()
        take(matches[highlight]!)
        return
      }
      const completed = tabComplete(value, matches)
      if (completed !== null) {
        e.preventDefault()
        onChange(completed)
        setOpen(true)
      }
      return
    }
    if (!visible) {
      if (e.key === 'ArrowDown' && matches.length) {
        e.preventDefault()
        setOpen(true)
        setHighlight(0)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % matches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h <= 0 ? matches.length - 1 : h - 1))
    } else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault()
      take(matches[highlight]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="relative min-w-[240px] flex-1">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          setFocused(true)
          setOpen(true)
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={visible && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        className={className}
        {...rest}
      />
      {visible && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-auto rounded-lg bg-popover p-1 text-[12px] text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {matches.map((s, i) => (
            <li
              key={s.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              // mousedown, not click: a click would blur the input first and close the list.
              onMouseDown={(e) => {
                e.preventDefault()
                take(s)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 font-mono ${i === highlight ? 'bg-accent text-accent-foreground' : ''}`}
            >
              {s.isDirectory ? <Folder className="size-3.5 shrink-0 text-primary" /> : <File className="size-3.5 shrink-0 text-faint" />}
              <span className="truncate">{s.label}</span>
            </li>
          ))}
          <li className="px-2 pt-1 text-[10px] text-faint" aria-hidden>
            Tab completes · ↑↓ pick · Enter takes
          </li>
        </ul>
      )}
    </div>
  )
}
