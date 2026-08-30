'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, CornerLeftUp, FileText, Folder, Link2, RefreshCw, Search } from 'lucide-react'
import { api, unwrap, type Connection, type FileEntry } from '@/lib/api'
import { formatBytes, formatDate, formatMode, joinPath, parentPath } from '@/lib/format'
import { EndpointSelect, type PaneEndpoint } from '@/components/endpoint-select'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export type { PaneEndpoint }

export type PaneState = {
  endpoint: PaneEndpoint
  path: string
  entries: FileEntry[]
  selected: Set<string>
  loading: boolean
  error: string | null
  /** Set when the server has SFTP but no rsync: browse yes, transfer no. */
  transfersDisabled: boolean
}

export function endpointLabel(endpoint: PaneEndpoint, connections: readonly Connection[]): string {
  if (endpoint.kind === 'local') return 'This computer'
  return connections.find((connection) => connection.id === endpoint.connectionId)?.name ?? 'server'
}

/** Breadcrumbs without a library: the path is the only source of truth. */
function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = useMemo(() => {
    const segments = path.split('/').filter(Boolean)
    const absolute = path.startsWith('/')
    return segments.map((name, index) => ({
      name,
      target: (absolute ? '/' : '') + segments.slice(0, index + 1).join('/'),
    }))
  }, [path])

  return (
    <div className="selectable flex min-w-0 flex-1 items-center gap-1 overflow-hidden font-[family-name:var(--font-mono)] text-[12px]">
      <button
        type="button"
        onClick={() => onNavigate(path.startsWith('/') ? '/' : '.')}
        className="shrink-0 text-faint transition-colors hover:text-foreground"
      >
        {path.startsWith('/') ? '/' : '.'}
      </button>
      {parts.map((part, index) => (
        <span key={part.target} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <ChevronRight className="size-3 shrink-0 text-faint/60" /> : null}
          <button
            type="button"
            onClick={() => onNavigate(part.target)}
            className={cn(
              'truncate transition-colors hover:text-foreground',
              index === parts.length - 1 ? 'font-medium text-foreground' : 'text-dim',
            )}
          >
            {part.name}
          </button>
        </span>
      ))}
    </div>
  )
}

export function Pane({
  role,
  state,
  saved,
  sshConfig,
  active,
  onFocus,
  onChange,
  onNavigate,
  onEndpointChange,
  onAddServer,
}: {
  role: 'Source' | 'Destination'
  state: PaneState
  saved: readonly Connection[]
  sshConfig: readonly Connection[]
  active: boolean
  onFocus: () => void
  onChange: (patch: Partial<PaneState>) => void
  onNavigate: (path: string) => void
  onEndpointChange: (endpoint: PaneEndpoint) => void
  onAddServer: () => void
}) {
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => setFilter(''), [state.path])

  const visible = useMemo(
    () =>
      state.entries
        .filter((entry) => showHidden || !entry.name.startsWith('.'))
        .filter((entry) => filter === '' || entry.name.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => {
          // Directories first, then by name: the order every file manager uses.
          if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        }),
    [state.entries, filter, showHidden],
  )

  const selectedSize = visible
    .filter((entry) => state.selected.has(entry.name))
    .reduce((total, entry) => total + entry.size, 0)

  function toggle(name: string, additive: boolean) {
    const next = new Set(additive ? state.selected : [])
    if (state.selected.has(name) && additive) next.delete(name)
    else next.add(name)
    onChange({ selected: next })
  }

  return (
    <section
      onMouseDown={onFocus}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card transition-colors',
        active ? 'border-line-strong' : 'border-line',
      )}
      aria-label={role}
    >
      <header className="flex items-center gap-2.5 border-b border-line bg-[#101828] px-3 py-2.5">
        <EndpointSelect
          value={state.endpoint}
          saved={saved}
          sshConfig={sshConfig}
          onChange={onEndpointChange}
          onAddServer={onAddServer}
        />
        <span className="text-[10px] uppercase tracking-[0.09em] text-faint">{role}</span>
        {state.transfersDisabled ? (
          <span className="ml-auto rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">rsync missing</span>
        ) : null}
      </header>

      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          title="Up one directory"
          onClick={() => onNavigate(parentPath(state.path))}
          className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <CornerLeftUp className="size-[15px]" />
        </button>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-line bg-background px-2.5 py-1">
          <Breadcrumbs path={state.path} onNavigate={onNavigate} />
        </div>
        <button
          type="button"
          title="Refresh"
          onClick={() => onNavigate(state.path)}
          className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <RefreshCw className={cn('size-[14px]', state.loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={filter}
            placeholder="Filter"
            onChange={(event) => setFilter(event.target.value)}
            className="h-7 border-line bg-background pl-8 text-[12px]"
          />
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
            className="accent-primary"
          />
          Hidden
        </label>
      </div>

      <div className="grid grid-cols-[1fr_78px_118px] border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="text-right">Modified</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {state.error ? (
          <p className="selectable p-3 text-[12px] text-destructive">{state.error}</p>
        ) : state.loading ? (
          <p className="p-3 text-[12px] text-muted-foreground">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="p-3 text-[12px] text-muted-foreground">{filter ? 'Nothing matches' : 'Empty'}</p>
        ) : (
          visible.map((entry) => {
            const isSelected = state.selected.has(entry.name)
            return (
              <div
                key={entry.path}
                onClick={(event) => toggle(entry.name, event.ctrlKey || event.metaKey)}
                onDoubleClick={() => {
                  if (entry.type === 'directory') onNavigate(joinPath(state.path, entry.name))
                }}
                className={cn(
                  'grid h-[34px] cursor-default grid-cols-[1fr_78px_118px] items-center border-l-2 px-3 text-[12.5px]',
                  isSelected ? 'border-l-primary bg-[#132446]' : 'border-l-transparent hover:bg-secondary',
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {entry.type === 'directory' ? (
                    <Folder className="size-[15px] shrink-0 text-primary" />
                  ) : entry.type === 'symlink' ? (
                    <Link2 className="size-[15px] shrink-0 text-cyan" />
                  ) : (
                    <FileText className="size-[15px] shrink-0 text-[#5b6b85]" />
                  )}
                  <span className={cn('truncate', isSelected ? 'text-white' : 'text-dim')}>{entry.name}</span>
                </span>
                <span className="text-right font-[family-name:var(--font-mono)] text-[11.5px] text-muted-foreground">
                  {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
                </span>
                <span
                  className="text-right font-[family-name:var(--font-mono)] text-[11.5px] text-muted-foreground"
                  title={formatMode(entry.mode)}
                >
                  {formatDate(entry.modifiedAt)}
                </span>
              </div>
            )
          })
        )}
      </ScrollArea>

      <footer className="flex items-center gap-2.5 border-t border-line bg-sunken px-3 py-2 text-[11.5px] text-muted-foreground">
        <span>
          <span className="text-dim">{visible.length}</span> items
        </span>
        {state.selected.size > 0 ? (
          <span>
            · <span className="text-primary">{state.selected.size}</span> selected · {formatBytes(selectedSize)}
          </span>
        ) : null}
      </footer>
    </section>
  )
}

/** Loads a directory for whichever endpoint the pane is pointing at. */
export async function loadPane(endpoint: PaneEndpoint, path: string): Promise<{ path: string; entries: FileEntry[] }> {
  const bridge = api()
  if (endpoint.kind === 'local') return unwrap(bridge?.fs.listLocal(path))
  return unwrap(bridge?.fs.listRemote(endpoint.connectionId, path))
}
