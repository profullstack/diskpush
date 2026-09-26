'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, HardDriveDownload, Loader2, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, unwrap, type Connection, type FleetSyncEvent } from '@/lib/api'

/**
 * Fleet Sync — push one source path out to many hosts at once.
 *
 * Pick a source (a server or this machine) + a path, tick the destination
 * servers, and it runs one transfer per destination (server-to-server when the
 * source is remote), streaming a progress row for each. The heavy lifting is the
 * same transfer engine the two-pane view uses; this is just the fan-out.
 */

type DestState = 'pending' | 'running' | 'done' | 'error'
type DestView = { id: string; name: string; host: string; state: DestState; percent: number; message: string }

const STATE_ICON: Record<DestState, React.ReactNode> = {
  pending: <CircleDashed className="size-3.5 text-faint" />,
  running: <Loader2 className="size-3.5 animate-spin text-primary" />,
  done: <CircleCheck className="size-3.5 text-ok" />,
  error: <CircleAlert className="size-3.5 text-destructive" />,
}

export function FleetSyncPanel() {
  const [servers, setServers] = useState<Connection[]>([])
  const [sourceId, setSourceId] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [destPath, setDestPath] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [syncId, setSyncId] = useState<string | null>(null)
  const [dests, setDests] = useState<Record<string, DestView>>({})

  const active = useMemo(
    () => Object.values(dests).some((d) => d.state === 'pending' || d.state === 'running'),
    [dests],
  )

  useEffect(() => {
    void (async () => {
      const list = (await unwrap(api()?.fleet.servers())) ?? []
      setServers(list)
      setSourceId((cur) => cur || list[0]?.id || '')
    })()
  }, [])

  useEffect(() => {
    const off = api()?.events.onFleetSync(({ connectionId, event }) => {
      if (!connectionId) return // the null-keyed 'done' marker
      setDests((prev) => {
        const cur = prev[connectionId]
        if (!cur) return prev
        const e = event as FleetSyncEvent
        const next = { ...cur }
        if (e.type === 'begin') next.state = 'running'
        else if (e.type === 'progress') {
          next.state = 'running'
          next.percent = Math.max(0, Math.min(100, Math.round(e.progress.percent)))
        } else if (e.type === 'stderr') next.message = e.line
        else if (e.type === 'error') {
          next.state = 'error'
          next.message = e.message
        } else if (e.type === 'exit') {
          const ok = e.code === 0 || e.code === 24
          next.state = ok ? 'done' : 'error'
          next.percent = ok ? 100 : next.percent
          if (!ok) next.message = e.message
        }
        return { ...prev, [connectionId]: next }
      })
    })
    return () => off?.()
  }, [])

  const destServers = useMemo(() => servers.filter((s) => s.id !== sourceId), [servers, sourceId])
  const canRun = Boolean(sourceId) && sourcePath.trim().length > 0 && selected.size > 0 && !active

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const run = useCallback(async () => {
    const ids = [...selected].filter((id) => id !== sourceId)
    if (!sourceId || ids.length === 0 || sourcePath.trim().length === 0) return

    const initial: Record<string, DestView> = {}
    for (const id of ids) {
      const s = servers.find((x) => x.id === id)
      initial[id] = { id, name: s?.name ?? id, host: s?.host ?? '', state: 'pending', percent: 0, message: '' }
    }
    setDests(initial)

    const source =
      sourceId === 'local'
        ? { type: 'local' as const, path: sourcePath.trim() }
        : { type: 'ssh' as const, connectionId: sourceId, path: sourcePath.trim() }

    const res = await unwrap(
      api()?.fleet.sync({
        source,
        destinationConnectionIds: ids,
        destinationPath: destPath.trim() || sourcePath.trim(),
        options: {},
        concurrency: 4,
      }),
    )
    setSyncId(res?.syncId ?? null)
  }, [selected, sourceId, sourcePath, destPath, servers])

  const cancel = useCallback(async () => {
    if (syncId) await api()?.fleet.cancelSync(syncId)
  }, [syncId])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <HardDriveDownload className="size-4 text-primary" />
        Sync a path to the fleet
      </div>

      {/* Source */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-faint">Source</label>
        <select
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          className="h-[var(--control)] rounded-md border border-line-strong bg-background px-2 text-[12px]"
        >
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Input
          value={sourcePath}
          onChange={(e) => setSourcePath(e.target.value)}
          placeholder="/path/on/source"
          className="h-[var(--control)] min-w-[240px] flex-1 text-[12px]"
        />
      </div>

      {/* Destination path */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-faint">Dest path</label>
        <Input
          value={destPath}
          onChange={(e) => setDestPath(e.target.value)}
          placeholder="defaults to the source path"
          className="h-[var(--control)] min-w-[240px] flex-1 text-[12px]"
        />
      </div>

      {/* Destination servers */}
      <div className="text-[11px] text-faint">
        Destinations {selected.size > 0 ? `· ${[...selected].filter((id) => id !== sourceId).length}` : ''}
      </div>
      <ScrollArea className="min-h-0 max-h-40 rounded-md border border-line">
        <div className="flex flex-col">
          {destServers.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-secondary">
              <Checkbox checked={selected.has(s.id)} onCheckedChange={() => toggle(s.id)} />
              <span className="truncate">{s.name}</span>
              <span className="ml-auto truncate text-faint">{s.host}</span>
            </label>
          ))}
        </div>
      </ScrollArea>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button onClick={() => void run()} disabled={!canRun} className="h-[var(--control)] gap-2 text-[12px]">
          <Play className="size-3.5" />
          Sync to {[...selected].filter((id) => id !== sourceId).length || ''} server(s)
        </Button>
        {active ? (
          <Button variant="outline" onClick={() => void cancel()} className="h-[var(--control)] gap-2 text-[12px]">
            <Square className="size-3.5" />
            Cancel
          </Button>
        ) : null}
      </div>

      {/* Per-destination progress */}
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-line">
        <div className="flex flex-col">
          {Object.values(dests).map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-2 py-1.5 text-[12px]">
              {STATE_ICON[d.state]}
              <span className="w-40 truncate">{d.name}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-secondary">
                <div
                  className={`h-full ${d.state === 'error' ? 'bg-destructive' : 'bg-primary'}`}
                  style={{ width: `${d.percent}%` }}
                />
              </div>
              <span className="w-10 text-right text-faint">{d.percent}%</span>
              {d.message ? <span className="max-w-[40%] truncate text-faint">{d.message}</span> : null}
            </div>
          ))}
          {Object.keys(dests).length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-faint">Pick a source, a path, and destinations, then Sync.</div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
