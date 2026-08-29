'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, unwrap, type Connection, type FileEntry } from '@/lib/api'
import { formatBytes, formatDate, formatMode, joinPath, parentPath } from '@/lib/format'
import { Button, Input, Panel } from './ui'

/**
 * One side of the workspace.
 *
 * `endpoint` is either the local machine or a saved connection; the pane does
 * not care which, which is what makes Server A -> Server B an ordinary case
 * rather than a special mode.
 */
export type PaneEndpoint = { kind: 'local' } | { kind: 'ssh'; connectionId: string }

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
  if (endpoint.kind === 'local') return 'Local'
  return connections.find((connection) => connection.id === endpoint.connectionId)?.name ?? 'Unknown server'
}

export function Pane({
  title,
  state,
  connections,
  onChange,
  onNavigate,
  onEndpointChange,
  onAddServer,
}: {
  title: string
  state: PaneState
  connections: readonly Connection[]
  onChange: (patch: Partial<PaneState>) => void
  onNavigate: (path: string) => void
  onEndpointChange: (endpoint: PaneEndpoint) => void
  onAddServer: () => void
}) {
  const [pathDraft, setPathDraft] = useState(state.path)
  const [showHidden, setShowHidden] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => setPathDraft(state.path), [state.path])

  const toggle = useCallback(
    (name: string, additive: boolean) => {
      const next = new Set(additive ? state.selected : [])
      if (state.selected.has(name) && additive) next.delete(name)
      else next.add(name)
      onChange({ selected: next })
    },
    [state.selected, onChange],
  )

  const visible = state.entries
    .filter((entry) => showHidden || !entry.name.startsWith('.'))
    .filter((entry) => filter === '' || entry.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      // Directories first, then by name. The most useful order in a file
      // manager, and the one every other one uses.
      if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  return (
    <Panel className="flex-1">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted">{title}</span>
        <select
          value={state.endpoint.kind === 'local' ? 'local' : state.endpoint.connectionId}
          onChange={(event) => {
            if (event.target.value === '__add__') {
              onAddServer()
              return
            }
            onEndpointChange(
              event.target.value === 'local' ? { kind: 'local' } : { kind: 'ssh', connectionId: event.target.value },
            )
          }}
          className="rounded-md border border-line bg-ink px-2 py-1 text-[12px] outline-none focus:border-accent"
        >
          <option value="local">Local</option>
          {connections.length > 0 ? <option disabled>──────────</option> : null}
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
          <option value="__add__">+ New Server</option>
        </select>
        {state.transfersDisabled ? (
          <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">rsync missing</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <Button variant="ghost" title="Up one directory" onClick={() => onNavigate(parentPath(state.path))}>
          ↑
        </Button>
        <Button variant="ghost" title="Refresh" onClick={() => onNavigate(state.path)}>
          ⟳
        </Button>
        <form
          className="flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            onNavigate(pathDraft)
          }}
        >
          <Input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} spellCheck={false} />
        </form>
      </div>

      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <Input
          value={filter}
          placeholder="Filter"
          onChange={(event) => setFilter(event.target.value)}
          className="h-7 flex-1 py-1 text-[12px]"
        />
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-[var(--color-accent)]" />
          Hidden
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.error ? (
          <div className="select-text p-3 text-[12px] text-danger">{state.error}</div>
        ) : state.loading ? (
          <div className="p-3 text-[12px] text-muted">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="p-3 text-[12px] text-muted">Empty</div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Name</th>
                <th className="w-20 px-2 py-1 text-right font-medium">Size</th>
                <th className="w-32 px-2 py-1 text-left font-medium">Modified</th>
                <th className="w-14 px-2 py-1 text-left font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr
                  key={entry.path}
                  onClick={(event) => toggle(entry.name, event.ctrlKey || event.metaKey)}
                  onDoubleClick={() => {
                    if (entry.type === 'directory') onNavigate(joinPath(state.path, entry.name))
                  }}
                  className={`cursor-default border-b border-line/40 ${
                    state.selected.has(entry.name) ? 'bg-accent/15' : 'hover:bg-raised'
                  }`}
                >
                  <td className="truncate px-2 py-1">
                    <span className="mr-1.5 text-muted">
                      {entry.type === 'directory' ? '▸' : entry.type === 'symlink' ? '↳' : '·'}
                    </span>
                    {entry.name}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted">
                    {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
                  </td>
                  <td className="px-2 py-1 text-muted">{formatDate(entry.modifiedAt)}</td>
                  <td className="px-2 py-1 font-mono text-[11px] text-muted">{formatMode(entry.mode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-2 py-1 text-[11px] text-muted">
        <span>{visible.length} items</span>
        <span>{state.selected.size > 0 ? `${state.selected.size} selected` : ''}</span>
      </div>
    </Panel>
  )
}

/** Loads a directory for whichever endpoint the pane is pointing at. */
export async function loadPane(endpoint: PaneEndpoint, path: string): Promise<{ path: string; entries: FileEntry[] }> {
  const bridge = api()
  if (endpoint.kind === 'local') return unwrap(bridge?.fs.listLocal(path))
  return unwrap(bridge?.fs.listRemote(endpoint.connectionId, path))
}
