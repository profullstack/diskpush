'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  CornerLeftUp,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  PenLine,
  RefreshCw,
  Search,
  ServerCrash,
  SearchX,
  Trash2,
} from 'lucide-react'
import { api, unwrap, type Connection, type FileEntry } from '@/lib/api'
import { isNavigable } from '@/lib/entries'
import { formatBytes, formatDate, formatMode, joinPath, parentPath } from '@/lib/format'
import { EndpointSelect, type PaneEndpoint } from '@/components/endpoint-select'
import { DeleteDialog, NameDialog } from '@/components/entry-dialogs'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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

/** The three data columns, in one place so header and rows cannot drift apart. */
const COLUMNS = 'grid-cols-[minmax(0,1fr)_84px_124px]'

/** An icon-only control: same box, same hover, same focus ring, every time. */
function IconAction({
  label,
  onClick,
  children,
  className,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
              'focus-ring flex size-[var(--control)] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:translate-y-px',
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
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

  const scroller = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)

  // A long path scrolls rather than truncates, and it is scrolled to the end,
  // because the folder you are actually in is the tail of the string. Doing
  // this with `dir="rtl"` also right-aligns a SHORT path, which leaves the
  // field looking empty with the crumbs shoved against the refresh button.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    element.scrollLeft = element.scrollWidth
    setClipped(element.scrollLeft > 0)
  }, [path])

  return (
    <div
      ref={scroller}
      onScroll={(event) => setClipped(event.currentTarget.scrollLeft > 0)}
      className={cn(
        'selectable numeric flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap text-[12px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        // Without this a scrolled path begins mid-word against a hard edge,
        // which reads as a rendering fault rather than as "there is more here".
        clipped && '[mask-image:linear-gradient(to_right,transparent_0,black_18px)]',
      )}
    >
      <button
        type="button"
        onClick={() => onNavigate(path.startsWith('/') ? '/' : '.')}
        className="focus-ring shrink-0 rounded px-0.5 text-faint transition-colors hover:text-foreground"
      >
        {path.startsWith('/') ? '/' : '.'}
      </button>
      {parts.map((part, index) => (
        <span key={part.target} className="flex shrink-0 items-center gap-1">
          {index > 0 ? <ChevronRight className="size-3 shrink-0 text-faint/60" /> : null}
          <button
            type="button"
            onClick={() => onNavigate(part.target)}
            className={cn(
              'focus-ring rounded px-0.5 transition-colors hover:text-foreground',
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

/** Rows that are the right shape before the listing lands, instead of the word "Loading". */
function LoadingRows() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 9 }, (_, index) => (
        <div key={index} className={cn('grid h-[var(--row)] items-center gap-3 px-3', COLUMNS)}>
          <span className="flex items-center gap-2.5">
            <span className="size-[15px] shrink-0 rounded-sm bg-secondary" />
            <span className="h-[9px] rounded-full bg-secondary" style={{ width: `${38 + ((index * 13) % 42)}%` }} />
          </span>
          <span className="ml-auto h-[9px] w-10 rounded-full bg-secondary" />
          <span className="ml-auto h-[9px] w-20 rounded-full bg-secondary" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  detail,
  tone = 'muted',
}: {
  icon: React.ReactNode
  title: string
  detail?: string
  tone?: 'muted' | 'danger'
}) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span
        className={cn(
          'flex size-9 items-center justify-center rounded-full',
          tone === 'danger' ? 'bg-danger-surface text-destructive' : 'bg-secondary text-faint',
        )}
      >
        {icon}
      </span>
      <p className={cn('text-[12.5px] font-medium', tone === 'danger' ? 'text-danger-ink' : 'text-dim')}>{title}</p>
      {detail ? <p className="selectable max-w-[46ch] text-[11.5px] leading-relaxed text-faint">{detail}</p> : null}
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
  onRefreshHosts,
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
  onRefreshHosts?: () => void
}) {
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  // The row the keyboard is on. Distinct from selection: you can walk the list
  // without changing what is selected, the way every file manager behaves.
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<number | null>(null)
  // The row the context menu was opened on. Null when it was opened on empty
  // space, which is what distinguishes "new file here" from "rename this".
  const [target, setTarget] = useState<FileEntry | null>(null)
  const [dialog, setDialog] = useState<'mkdir' | 'create-file' | 'rename' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)

  useEffect(() => {
    setFilter('')
    setCursor(0)
    anchor.current = null
  }, [state.path])

  const visible = useMemo(
    () =>
      state.entries
        .filter((entry) => showHidden || !entry.name.startsWith('.'))
        .filter((entry) => filter === '' || entry.name.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => {
          // Directories first, then by name: the order every file manager uses.
          // A link to a directory sorts as one, because that is what it opens as.
          if (isNavigable(a) !== isNavigable(b)) return isNavigable(a) ? -1 : 1
          return a.name.localeCompare(b.name)
        }),
    [state.entries, filter, showHidden],
  )

  const selectedSize = visible
    .filter((entry) => state.selected.has(entry.name))
    .reduce((total, entry) => total + entry.size, 0)

  // Directories report their own inode size, not their contents, so counting
  // them would make the total wrong in a way that looks authoritative.
  const totalSize = visible
    .filter((entry) => entry.type !== 'directory')
    .reduce((total, entry) => total + entry.size, 0)

  const select = useCallback(
    (index: number, mode: 'replace' | 'toggle' | 'range') => {
      const entry = visible[index]
      if (!entry) return
      if (mode === 'range' && anchor.current !== null) {
        const [from, to] = anchor.current <= index ? [anchor.current, index] : [index, anchor.current]
        onChange({ selected: new Set(visible.slice(from, to + 1).map((item) => item.name)) })
        return
      }
      anchor.current = index
      if (mode === 'toggle') {
        const next = new Set(state.selected)
        if (next.has(entry.name)) next.delete(entry.name)
        else next.add(entry.name)
        onChange({ selected: next })
        return
      }
      onChange({ selected: new Set([entry.name]) })
    },
    [onChange, state.selected, visible],
  )

  const open = useCallback(
    (entry: FileEntry) => {
      // The link's own path is what we navigate to: the server resolves it when
      // it lists, so there is no need to send the target and no risk of leaving
      // the path the user can see in the breadcrumbs.
      if (isNavigable(entry)) onNavigate(joinPath(state.path, entry.name))
    },
    [onNavigate, state.path],
  )

  const connectionId = state.endpoint.kind === 'local' ? undefined : state.endpoint.connectionId

  const closeDialog = useCallback(() => {
    setDialog(null)
    setOpError(null)
  }, [])

  /**
   * Runs one file operation and reloads the directory.
   *
   * The listing is re-read from the endpoint rather than patched locally: the
   * server is the only thing that knows whether the operation really happened,
   * and a pane that shows an optimistic folder which does not exist is worse
   * than one that takes a moment.
   */
  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      setBusy(true)
      setOpError(null)
      try {
        await operation()
        closeDialog()
        onNavigate(state.path)
      } catch (error) {
        setOpError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [closeDialog, onNavigate, state.path],
  )

  /** Opens the menu against `entry`, selecting it the way a right-click should. */
  const aimAt = useCallback(
    (entry: FileEntry | null, index: number) => {
      setTarget(entry)
      if (!entry) return
      setCursor(index)
      if (!state.selected.has(entry.name)) onChange({ selected: new Set([entry.name]) })
    },
    [onChange, state.selected],
  )

  /**
   * Arrow keys walk the list, Enter opens, Backspace goes up.
   *
   * The list previously answered only to the mouse, which is what made a
   * file pane full of rows feel like a picture of a file pane.
   */
  function onKeyDown(event: React.KeyboardEvent) {
    if (visible.length === 0) return
    const step = (delta: number) => {
      event.preventDefault()
      const next = Math.min(visible.length - 1, Math.max(0, cursor + delta))
      setCursor(next)
      select(next, event.shiftKey ? 'range' : 'replace')
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (event.key) {
      case 'ArrowDown':
        return step(1)
      case 'ArrowUp':
        return step(-1)
      case 'PageDown':
        return step(10)
      case 'PageUp':
        return step(-10)
      case 'Home':
        return step(-visible.length)
      case 'End':
        return step(visible.length)
      case 'Enter':
        event.preventDefault()
        return open(visible[cursor])
      case 'Backspace':
        event.preventDefault()
        return onNavigate(parentPath(state.path))
      case 'F2':
        event.preventDefault()
        aimAt(visible[cursor] ?? null, cursor)
        return setDialog('rename')
      case 'Delete':
        event.preventDefault()
        aimAt(visible[cursor] ?? null, cursor)
        return setDialog('delete')
      case 'a':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          onChange({ selected: new Set(visible.map((entry) => entry.name)) })
        }
        return
      default:
        return
    }
  }

  return (
    <section
      onMouseDown={onFocus}
      className={cn(
        'elevation-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card transition-colors',
        // The active pane is the one a transfer will read from or write to, so
        // it is worth more than a one-shade border change.
        active ? 'border-line-strong ring-1 ring-primary/25' : 'border-line',
      )}
      aria-label={role}
    >
      <header className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line bg-chrome px-2.5">
        <EndpointSelect
          value={state.endpoint}
          saved={saved}
          sshConfig={sshConfig}
          onChange={onEndpointChange}
          onAddServer={onAddServer}
          onOpen={onRefreshHosts}
        />
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.09em] transition-colors',
            active ? 'bg-primary/12 text-primary' : 'text-faint',
          )}
        >
          {role}
        </span>
        {state.transfersDisabled ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="ml-auto shrink-0 cursor-default rounded-md bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn" />
              }
            >
              rsync missing
            </TooltipTrigger>
            <TooltipContent>This server can be browsed over SFTP, but cannot transfer.</TooltipContent>
          </Tooltip>
        ) : null}
      </header>

      {/*
        One toolbar, not two. The path, the filter and the hidden-files toggle
        used to occupy a band each, so every pane spent four full-width rules
        on chrome before showing a single file.
      */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-2">
        <IconAction label="Up one directory" onClick={() => onNavigate(parentPath(state.path))}>
          <CornerLeftUp className="size-[15px]" />
        </IconAction>
        <div className="flex h-[var(--control)] min-w-0 flex-1 items-center rounded-md border border-line bg-background px-2.5">
          <Breadcrumbs path={state.path} onNavigate={onNavigate} />
        </div>
        <IconAction label="Refresh" onClick={() => onNavigate(state.path)}>
          <RefreshCw className={cn('size-[14px]', state.loading && 'animate-spin')} />
        </IconAction>
        <div className="relative w-[124px] shrink-0 lg:w-[150px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={filter}
            placeholder="Filter"
            aria-label={`Filter ${role.toLowerCase()} listing`}
            onChange={(event) => setFilter(event.target.value)}
            className="h-[var(--control)] border-line bg-background pl-8 text-[12px]"
          />
        </div>
        <label className="flex h-[var(--control)] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <Checkbox checked={showHidden} onCheckedChange={(next) => setShowHidden(next === true)} />
          Hidden
        </label>
      </div>

      <div
        className={cn(
          'grid shrink-0 gap-3 border-b border-line bg-sunken/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint',
          COLUMNS,
        )}
      >
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="text-right">Modified</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                ref={listRef}
                role="listbox"
                aria-label={`${role} files`}
                tabIndex={0}
                onKeyDown={onKeyDown}
                // A right-click on empty space aims at the directory itself.
                // Guarded by where the click landed, because this fires after
                // the row's own handler as the event bubbles: clearing
                // unconditionally left Rename and Delete greyed out on every
                // row, which is exactly how it shipped in the first draft.
                onContextMenu={(event: React.MouseEvent) => {
                  if (!(event.target as HTMLElement).closest('[data-row]')) setTarget(null)
                }}
                className="focus-ring h-full outline-none"
              />
            }
          >
          {state.error ? (
            <EmptyState
              tone="danger"
              icon={<ServerCrash className="size-[18px]" />}
              title="Could not read this directory"
              detail={state.error}
            />
          ) : state.loading ? (
            <LoadingRows />
          ) : visible.length === 0 ? (
            filter ? (
              <EmptyState
                icon={<SearchX className="size-[18px]" />}
                title={`Nothing matches “${filter}”`}
                detail={
                  state.entries.length > 0
                    ? `${state.entries.length} item${state.entries.length === 1 ? '' : 's'} here, none with that in the name.`
                    : undefined
                }
              />
            ) : (
              <EmptyState
                icon={<FolderOpen className="size-[18px]" />}
                title="This folder is empty"
                detail={showHidden ? undefined : 'Hidden files are not being shown.'}
              />
            )
          ) : (
            visible.map((entry, index) => {
              const isSelected = state.selected.has(entry.name)
              return (
                <div
                  key={entry.path}
                  data-row={index}
                  role="option"
                  aria-selected={isSelected}
                  onClick={(event) => {
                    setCursor(index)
                    select(index, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
                  }}
                  onDoubleClick={() => open(entry)}
                  onContextMenu={() => aimAt(entry, index)}
                  className={cn(
                    'grid h-[var(--row)] cursor-default items-center gap-3 border-l-2 px-3 text-[12.5px] transition-colors',
                    COLUMNS,
                    isSelected
                      ? 'border-l-primary bg-primary/14'
                      : 'border-l-transparent hover:bg-secondary/70',
                    cursor === index && !isSelected && 'bg-secondary/40',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {entry.type === 'directory' ? (
                      <Folder className="size-[15px] shrink-0 fill-primary/20 text-primary" />
                    ) : entry.type === 'symlink' ? (
                      // A link that opens as a folder is drawn as one, tinted to
                      // keep it distinguishable from a real directory.
                      isNavigable(entry) ? (
                        <Folder className="size-[15px] shrink-0 fill-cyan/20 text-cyan" />
                      ) : (
                        <Link2 className="size-[15px] shrink-0 text-cyan" />
                      )
                    ) : (
                      <FileText className="size-[15px] shrink-0 text-faint" />
                    )}
                    <span
                      className={cn('truncate', isSelected ? 'font-medium text-foreground' : 'text-dim')}
                      title={entry.linkTarget ? `${entry.name} → ${entry.linkTarget}` : undefined}
                    >
                      {entry.name}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'numeric text-right text-[11.5px]',
                      isNavigable(entry) ? 'text-faint' : 'text-muted-foreground',
                    )}
                  >
                    {isNavigable(entry) ? '—' : formatBytes(entry.size)}
                  </span>
                  <span className="numeric text-right text-[11.5px] text-muted-foreground" title={formatMode(entry.mode)}>
                    {formatDate(entry.modifiedAt)}
                  </span>
                </div>
              )
            })
          )}
          </ContextMenuTrigger>

          <ContextMenuContent>
            <ContextMenuItem onClick={() => onNavigate(state.path)}>
              <RefreshCw className="size-[14px] text-faint" />
              Refresh
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setDialog('mkdir')}>
              <FolderPlus className="size-[14px] text-faint" />
              New folder
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setDialog('create-file')}>
              <FilePlus2 className="size-[14px] text-faint" />
              New file
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!target} onClick={() => setDialog('rename')}>
              <PenLine className="size-[14px] text-faint" />
              Rename
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem variant="danger" disabled={!target} onClick={() => setDialog('delete')}>
              <Trash2 className="size-[14px]" />
              Delete
              <ContextMenuShortcut>Del</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </ScrollArea>

      <NameDialog
        open={dialog === 'mkdir' || dialog === 'create-file'}
        title={dialog === 'mkdir' ? 'New folder' : 'New file'}
        action="Create"
        busy={busy}
        error={opError}
        onClose={closeDialog}
        onSubmit={(name) =>
          run(() =>
            unwrap(
              dialog === 'mkdir'
                ? api()?.fs.mkdir(state.path, name, connectionId)
                : api()?.fs.createFile(state.path, name, connectionId),
            ),
          )
        }
      />

      <NameDialog
        open={dialog === 'rename'}
        title="Rename"
        action="Rename"
        initialValue={target?.name ?? ''}
        busy={busy}
        error={opError}
        onClose={closeDialog}
        onSubmit={(name) =>
          target && run(() => unwrap(api()?.fs.rename(state.path, target.name, name, connectionId)))
        }
      />

      <DeleteDialog
        open={dialog === 'delete'}
        name={target?.name ?? ''}
        isDirectory={target?.type === 'directory'}
        where={endpointLabel(state.endpoint, state.endpoint.kind === 'local' ? [] : [...saved, ...sshConfig])}
        busy={busy}
        error={opError}
        onClose={closeDialog}
        onConfirm={() =>
          target &&
          run(() => unwrap(api()?.fs.remove(state.path, target.name, target.type === 'directory', connectionId)))
        }
      />

      <footer className="flex h-[30px] shrink-0 items-center gap-2 border-t border-line bg-sunken px-3 text-[11.5px] text-muted-foreground">
        <span>
          <span className="numeric text-dim">{visible.length}</span> item{visible.length === 1 ? '' : 's'}
        </span>
        <span className="text-line-strong">·</span>
        {state.selected.size > 0 ? (
          <span className="text-primary">
            <span className="numeric font-medium">{state.selected.size}</span> selected
            <span className="numeric ml-1.5 text-muted-foreground">{formatBytes(selectedSize)}</span>
          </span>
        ) : (
          // What the pane adds up to is the question you actually have before
          // pressing Sync, and the strip was showing a bare count instead.
          <span className="numeric">{formatBytes(totalSize)}</span>
        )}
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
