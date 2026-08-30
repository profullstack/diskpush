'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Loader2,
  PlugZap,
  Play,
  RefreshCw,
  ShieldAlert,
  Bookmark,
  BookmarkPlus,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { blankHost, foldHosts, type HostView } from '@/lib/fleet-events'
import { readDraft, writeDraft } from '@/lib/fleet-draft'
import {
  api,
  unwrap,
  type Connection,
  type FleetCommand,
  type FleetEvent,
  type FleetHostState,
  type FleetList,
  type Hazard,
  type HostUpdateReport,
} from '@/lib/api'

/**
 * Fleet — one command, many servers.
 *
 * A full view, not a dialog. This is a place you work, with a long script in
 * front of you and a dozen servers reporting for minutes: everything a modal
 * is wrong for. The first version was a modal and the `upgrade` recipe's forty
 * lines pushed Run off the bottom of it, where nothing could scroll it back.
 *
 * So the layout has exactly three scrolling regions — servers, the editor, and
 * the results — and the action bar is pinned outside all of them. Run is
 * always on screen, whatever the script or the window is doing.
 *
 * Modals are kept for modality: the destructive-command confirmation below is
 * a real yes/no that blocks, which is what a dialog is actually for.
 */

const STATE_META: Record<FleetHostState, { label: string; tone: string; icon: React.ReactNode }> = {
  pending: { label: 'Waiting', tone: 'text-faint', icon: <CircleDashed className="size-3.5" /> },
  connecting: { label: 'Connecting', tone: 'text-muted-foreground', icon: <PlugZap className="size-3.5" /> },
  running: { label: 'Running', tone: 'text-primary', icon: <Loader2 className="size-3.5 animate-spin" /> },
  succeeded: { label: 'Succeeded', tone: 'text-ok', icon: <CircleCheck className="size-3.5" /> },
  failed: { label: 'Failed', tone: 'text-destructive', icon: <CircleAlert className="size-3.5" /> },
  unreachable: { label: 'Unreachable', tone: 'text-warn', icon: <PlugZap className="size-3.5" /> },
  timeout: { label: 'Timed out', tone: 'text-warn', icon: <Clock className="size-3.5" /> },
  cancelled: { label: 'Cancelled', tone: 'text-faint', icon: <Square className="size-3.5" /> },
  skipped: { label: 'Not run', tone: 'text-faint', icon: <CircleDashed className="size-3.5" /> },
}

export function FleetView({ onAddServer }: { onAddServer: () => void }) {
  const [servers, setServers] = useState<Connection[]>([])
  const [commands, setCommands] = useState<FleetCommand[]>([])
  const [lists, setLists] = useState<FleetList[]>([])
  const [savingList, setSavingList] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [savingCommand, setSavingCommand] = useState(false)
  const [newCommandName, setNewCommandName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(readDraft().selected))
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  // Read once, synchronously, as the initial state. Restoring in an effect
  // would paint an empty editor and then replace what you were looking at.
  const [draft] = useState(readDraft)

  const [script, setScript] = useState(draft.script)
  const [label, setLabel] = useState(draft.label)
  const [commandId, setCommandId] = useState<string | null>(null)
  const [interpreter, setInterpreter] = useState<'sh' | 'bash' | 'raw'>(draft.interpreter)
  const [sudo, setSudo] = useState(draft.sudo)
  // Never restored. A password is held for one run, and writing it anywhere it
  // could be read back is exactly what the CLI refuses to do.
  const [sudoPassword, setSudoPassword] = useState('')
  const [askSudoPassword, setAskSudoPassword] = useState(false)
  const [concurrency, setConcurrency] = useState(draft.concurrency)
  const [timeoutSeconds, setTimeoutSeconds] = useState(draft.timeoutSeconds)
  const [stopOnError, setStopOnError] = useState(draft.stopOnError)

  const [hazards, setHazards] = useState<Hazard[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [hosts, setHosts] = useState<HostView[]>([])
  const [checking, setChecking] = useState(false)
  const [reports, setReports] = useState<HostUpdateReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState<{ succeeded: number; failed: number; skipped: number } | null>(null)

  const running = runId !== null && finished === null
  const resultsRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [serverList, commandList, listList] = await Promise.all([
        unwrap(api()?.fleet.servers()),
        unwrap(api()?.fleet.commands()),
        unwrap(api()?.fleet.lists()),
      ])
      setServers(serverList)
      setCommands(commandList)
      setLists(listList)
      // A restored draft can name servers that have since been deleted.
      // Dropping them quietly is right here — this is a draft, not a saved
      // list, and there is nothing for the run to get wrong yet.
      const live = new Set(serverList.map((server) => server.id))
      setSelected((current) => {
        const kept = [...current].filter((id) => live.has(id))
        return kept.length === current.size ? current : new Set(kept)
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keep the draft current. Cheap, and it is the difference between closing
  // the window and losing a fifty-line script.
  useEffect(() => {
    writeDraft({ script, interpreter, sudo, concurrency, timeoutSeconds, stopOnError, label, selected: [...selected] })
  }, [script, interpreter, sudo, concurrency, timeoutSeconds, stopOnError, label, selected])

  useEffect(() => {
    const bridge = api()
    if (!bridge) return
    return bridge.events.onFleet(({ runId: incoming, event }) => {
      setRunId((current) => {
        if (current !== incoming) return current
        applyEvent(event, setHosts, setFinished, setError)
        return current
      })
    })
  }, [])

  useEffect(() => {
    // Follow the tail while it runs. Once it stops, leave the scroll where the
    // reader put it: yanking them to the bottom of a finished run is how you
    // lose the line you were reading.
    if (running && resultsRef.current) resultsRef.current.scrollTop = resultsRef.current.scrollHeight
  }, [hosts, running])

  const tags = useMemo(() => {
    const seen = new Map<string, string>()
    for (const server of servers) {
      for (const tag of server.tags ?? []) if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag)
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [servers])

  const visible = useMemo(
    () => (tagFilter ? servers.filter((server) => (server.tags ?? []).includes(tagFilter)) : servers),
    [servers, tagFilter],
  )

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAllVisible = () =>
    setSelected((current) => {
      const next = new Set(current)
      const everyOn = visible.length > 0 && visible.every((server) => next.has(server.id))
      for (const server of visible) {
        if (everyOn) next.delete(server.id)
        else next.add(server.id)
      }
      return next
    })

  /**
   * Ticks exactly the servers a list holds.
   *
   * Replaces the selection rather than adding to it: picking a list is saying
   * "these", and a list that quietly unioned with whatever was already ticked
   * would run on servers nobody chose.
   *
   * A member whose connection has gone is reported rather than skipped, the
   * same rule the CLI selector follows.
   */
  const pickList = (list: FleetList) => {
    const known = new Set(servers.map((server) => server.id))
    const missing = list.members.filter((member) => !known.has(member.connectionId))
    if (missing.length > 0) {
      setError(
        `The list "${list.name}" names ${missing.length} server(s) that no longer exist: ` +
          `${missing.map((member) => member.connectionName).join(', ')}. Save it again to drop them.`,
      )
      return
    }
    setError(null)
    setSelected(new Set(list.members.map((member) => member.connectionId)))
  }

  const saveList = useCallback(async () => {
    const name = newListName.trim()
    if (!name || selected.size === 0) return
    setError(null)
    try {
      await unwrap(api()?.fleet.saveList(name, [...selected]))
      setNewListName('')
      setSavingList(false)
      setLists(await unwrap(api()?.fleet.lists()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [newListName, selected])

  const removeList = useCallback(async (name: string) => {
    setError(null)
    try {
      await unwrap(api()?.fleet.removeList(name))
      setLists(await unwrap(api()?.fleet.lists()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const pickCommand = (command: FleetCommand) => {
    setScript(command.script)
    setLabel(command.name)
    setCommandId(command.builtin ? null : command.id)
    setInterpreter(command.interpreter)
    setSudo(command.sudo)
    setTimeoutSeconds(command.timeoutSeconds)
    // The pacing is part of the command: "reload nginx" and "upgrade the
    // database tier" want very different answers, and leaving whatever was
    // last on screen is how a saved command still gets run wrong.
    setConcurrency(command.concurrency)
    setStopOnError(command.onFailure === 'stop')
    setHazards([])
  }

  /** Saves everything on screen except the servers, which are chosen per run. */
  const saveCommand = useCallback(async () => {
    const name = newCommandName.trim()
    if (!name || !script.trim()) return
    setError(null)
    try {
      await unwrap(
        api()?.fleet.saveCommand({
          name,
          script,
          interpreter,
          sudo,
          workingDirectory: null,
          timeoutSeconds,
          concurrency,
          onFailure: stopOnError ? 'stop' : 'continue',
        }),
      )
      setNewCommandName('')
      setSavingCommand(false)
      setLabel(name)
      setCommands(await unwrap(api()?.fleet.commands()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [newCommandName, script, interpreter, sudo, timeoutSeconds, concurrency, stopOnError])

  const removeCommand = useCallback(async (name: string) => {
    setError(null)
    try {
      await unwrap(api()?.fleet.removeCommand(name))
      setCommands(await unwrap(api()?.fleet.commands()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const requestBody = useCallback(
    (hazardsConfirmed: boolean) => ({
      connectionIds: [...selected],
      script,
      interpreter,
      sudo,
      ...(sudo && askSudoPassword && sudoPassword ? { sudoPassword } : {}),
      workingDirectory: null,
      timeoutSeconds,
      concurrency,
      onFailure: stopOnError ? ('stop' as const) : ('continue' as const),
      hazardsConfirmed,
      commandId,
      label: label || script.slice(0, 60) || 'command',
    }),
    [
      selected,
      script,
      interpreter,
      sudo,
      askSudoPassword,
      sudoPassword,
      timeoutSeconds,
      concurrency,
      stopOnError,
      commandId,
      label,
    ],
  )

  const launch = useCallback(
    async (hazardsConfirmed: boolean) => {
      setError(null)
      setFinished(null)
      setReports(null)
      try {
        const request = requestBody(hazardsConfirmed)
        // Preview first, always. It is the only thing between a typo and forty
        // servers, and it costs one round trip with no side effects.
        const preview = await unwrap(api()?.fleet.preview(request))
        if (preview.hazards.length > 0 && !hazardsConfirmed) {
          setHazards(preview.hazards)
          return
        }
        setHazards([])
        setHosts(preview.servers.map(blankHost))
        const started = await unwrap(api()?.fleet.start(request))
        setRunId(started.runId)
      } catch (caught) {
        setHazards([])
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [requestBody],
  )

  const check = useCallback(async () => {
    setError(null)
    setChecking(true)
    setReports(null)
    try {
      setReports(await unwrap(api()?.fleet.check([...selected], concurrency)))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setChecking(false)
    }
  }, [selected, concurrency])

  const canRun = selected.size > 0 && script.trim().length > 0 && !running

  /**
   * Is what is on screen a saved command you are changing?
   *
   * Saving under an existing name has always updated it — the store upserts —
   * but the control said "Save these settings" either way, so there was no way
   * to tell an edit from a new one.
   */
  const editingSaved = commands.some((command) => !command.builtin && command.name === label)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? (
        <div className="flex shrink-0 items-start gap-2.5 border-b border-danger-line bg-danger-surface px-4 py-2.5 text-[12px] text-danger-ink">
          <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="selectable min-w-0 flex-1">{error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setError(null)}
            className="focus-ring -mr-1 shrink-0 rounded p-0.5 text-danger-ink/70 transition-colors hover:text-danger-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* --- servers ------------------------------------------------- */}
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-line">
          <div className="flex shrink-0 items-center justify-between px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
              Servers {servers.length > 0 ? `· ${selected.size}/${servers.length}` : ''}
            </span>
            {visible.length > 0 ? (
              <Button variant="ghost" size="xs" onClick={selectAllVisible} className="text-[11px]">
                {visible.every((server) => selected.has(server.id)) ? 'None' : 'All'}
              </Button>
            ) : null}
          </div>

          {/*
            Saved lists first, then tags. A tag says what a server *is*; a list
            is a set someone assembled by hand and wants back, so it is the
            more deliberate of the two and sits above.
          */}
          {lists.length > 0 || selected.size > 0 ? (
            <div className="shrink-0 px-3 pb-2">
              <div className="flex flex-wrap items-center gap-1">
                {lists.map((list) => (
                  <span
                    key={list.id}
                    className="group/list inline-flex items-center overflow-hidden rounded-full border border-line-strong"
                  >
                    <button
                      type="button"
                      title={`${list.members.length} server${list.members.length === 1 ? '' : 's'}${
                        list.description ? ` — ${list.description}` : ''
                      }`}
                      onClick={() => pickList(list)}
                      disabled={running}
                      className="focus-ring flex items-center gap-1 py-0.5 pl-2 pr-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                      <Bookmark className="size-2.5" />
                      {list.name}
                      <span className="numeric text-faint">{list.members.length}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete the list ${list.name}`}
                      title={`Delete the list ${list.name} (the servers are untouched)`}
                      onClick={() => void removeList(list.name)}
                      disabled={running}
                      className="focus-ring px-1 py-0.5 text-faint opacity-0 transition-opacity hover:text-destructive group-hover/list:opacity-100"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}

                {selected.size > 0 && !savingList ? (
                  <button
                    type="button"
                    onClick={() => setSavingList(true)}
                    disabled={running}
                    className="focus-ring inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                  >
                    <BookmarkPlus className="size-2.5" />
                    Save these {selected.size}
                  </button>
                ) : null}
              </div>

              {savingList ? (
                <div className="mt-1.5 flex items-center gap-1">
                  <Input
                    autoFocus
                    value={newListName}
                    onChange={(event) => setNewListName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveList()
                      if (event.key === 'Escape') {
                        setSavingList(false)
                        setNewListName('')
                      }
                    }}
                    placeholder="list name"
                    className="h-6 flex-1 text-[11.5px]"
                  />
                  <Button size="xs" onClick={() => void saveList()} disabled={!newListName.trim()} className="text-[11px]">
                    Save
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {tags.length > 0 ? (
            <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTagFilter((current) => (current === tag ? null : tag))}
                  className={`focus-ring rounded-full border px-2 py-0.5 text-[10.5px] transition-colors ${
                    tagFilter === tag
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-line-strong text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          ) : null}

          <ScrollArea className="min-h-0 flex-1">
            <div className="px-1.5 pb-2">
              {visible.length === 0 ? (
                <div className="px-2 py-4">
                  <p className="text-[12px] text-muted-foreground">No servers yet.</p>
                  <Button variant="outline" size="sm" onClick={onAddServer} className="mt-2 w-full text-[11.5px]">
                    Add a server
                  </Button>
                </div>
              ) : null}
              {visible.map((server) => (
                <label
                  key={server.id}
                  className="group/field flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-secondary"
                >
                  <Checkbox
                    checked={selected.has(server.id)}
                    onCheckedChange={() => toggle(server.id)}
                    disabled={running}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{server.name}</span>
                    <span className="block truncate text-[10.5px] text-faint">
                      {server.username}@{server.host}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </ScrollArea>
        </aside>

        {/* --- command + results --------------------------------------- */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-line px-3 pb-2.5 pt-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-faint">Commands</span>
              {commands.map((command) => (
                <span
                  key={command.id}
                  className="group/cmd inline-flex items-center overflow-hidden rounded-md border border-line-strong"
                >
                  <button
                    type="button"
                    title={
                      `${command.description}\n${command.concurrency} at a time · ${command.timeoutSeconds}s` +
                      `${command.sudo ? ' · sudo' : ''}${command.onFailure === 'stop' ? ' · stops on failure' : ''}`
                    }
                    onClick={() => pickCommand(command)}
                    disabled={running}
                    className="focus-ring px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                  >
                    {command.name}
                  </button>
                  {/*
                    Only what someone saved can be deleted. A shipped recipe is
                    copied, not edited, so upgrading DiskPush never silently
                    changes a command anyone relies on.
                  */}
                  {command.builtin ? null : (
                    <button
                      type="button"
                      aria-label={`Delete the command ${command.name}`}
                      title={`Delete the saved command ${command.name}`}
                      onClick={() => void removeCommand(command.name)}
                      disabled={running}
                      className="focus-ring pr-1 text-faint opacity-0 transition-opacity hover:text-destructive group-hover/cmd:opacity-100"
                    >
                      <X className="size-2.5" />
                    </button>
                  )}
                </span>
              ))}

              {script.trim() && !savingCommand ? (
                <button
                  type="button"
                  onClick={() => {
                    // Prefill with the loaded command's name so saving over it
                    // is one keypress. Updating was always possible — saving
                    // under the same name upserts — but nothing said so.
                    setNewCommandName(editingSaved ? label : '')
                    setSavingCommand(true)
                  }}
                  disabled={running}
                  className="focus-ring inline-flex items-center gap-1 rounded-md border border-dashed border-line-strong px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <BookmarkPlus className="size-2.5" />
                  {editingSaved ? `Update ${label}` : 'Save these settings'}
                </button>
              ) : null}

              {savingCommand ? (
                <span className="inline-flex items-center gap-1">
                  <Input
                    autoFocus
                    value={newCommandName}
                    onChange={(event) => setNewCommandName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveCommand()
                      if (event.key === 'Escape') {
                        setSavingCommand(false)
                        setNewCommandName('')
                      }
                    }}
                    placeholder="command name"
                    className="h-6 w-[150px] text-[11.5px]"
                  />
                  <Button size="xs" onClick={() => void saveCommand()} disabled={!newCommandName.trim()} className="text-[11px]">
                    Save
                  </Button>
                </span>
              ) : null}
            </div>

            {/*
              A tall editor with its own scrollbar, not five rows.
              `upgrade` is forty lines of shell; showing five of them and
              hiding the rest behind a scroll gesture nobody knows is there is
              how the first version of this hid what it was about to run.
            */}
            <Textarea
              value={script}
              onChange={(event) => {
                setScript(event.target.value)
                setHazards([])
                setCommandId(null)
              }}
              disabled={running}
              spellCheck={false}
              placeholder="systemctl reload nginx"
              className="h-[clamp(120px,26vh,340px)] resize-y overflow-auto font-[family-name:var(--font-mono)] text-[12px] leading-[1.55]"
            />
            {script.includes('\n') ? (
              <p className="mt-1 text-[10.5px] text-faint">
                {script.split('\n').length} lines · runs under {interpreter === 'raw' ? 'one command line' : `${interpreter} -e`}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
              <label className="group/field flex items-center gap-1.5">
                <Checkbox checked={sudo} onCheckedChange={() => setSudo((value) => !value)} disabled={running} />
                <span>sudo</span>
              </label>
              {sudo ? (
                <label className="group/field flex items-center gap-1.5">
                  <Checkbox
                    checked={askSudoPassword}
                    onCheckedChange={() => setAskSudoPassword((value) => !value)}
                    disabled={running}
                  />
                  <span>with a password</span>
                </label>
              ) : null}
              {sudo && askSudoPassword ? (
                <Input
                  type="password"
                  value={sudoPassword}
                  onChange={(event) => setSudoPassword(event.target.value)}
                  placeholder="sudo password"
                  disabled={running}
                  className="h-7 w-[150px] text-[12px]"
                  autoComplete="off"
                />
              ) : null}
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">At once</span>
                <Input
                  type="number"
                  min={1}
                  max={64}
                  value={concurrency}
                  onChange={(event) => setConcurrency(Math.max(1, Number(event.target.value) || 1))}
                  disabled={running}
                  className="h-7 w-[56px] text-[12px]"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Timeout</span>
                <Input
                  type="number"
                  min={1}
                  value={timeoutSeconds}
                  onChange={(event) => setTimeoutSeconds(Math.max(1, Number(event.target.value) || 1))}
                  disabled={running}
                  // Wide enough for four digits: the upgrade recipe's default
                  // is 3600, and at 70px it rendered as "360C".
                  className="h-7 w-[86px] text-[12px]"
                />
                <span className="text-faint">s</span>
              </label>
              <label className="group/field flex items-center gap-1.5">
                <Checkbox
                  checked={stopOnError}
                  onCheckedChange={() => setStopOnError((value) => !value)}
                  disabled={running}
                />
                <span>Stop after a failure</span>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Shell</span>
                <select
                  value={interpreter}
                  onChange={(event) => setInterpreter(event.target.value as 'sh' | 'bash' | 'raw')}
                  disabled={running}
                  className="focus-ring h-7 rounded-md border border-input bg-background px-1.5 text-[12px]"
                >
                  <option value="raw">one command</option>
                  <option value="sh">sh script</option>
                  <option value="bash">bash script</option>
                </select>
              </label>
            </div>
          </div>

          <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto p-3">
            {reports ? <UpdateReportTable reports={reports} /> : null}
            {hosts.length === 0 && !reports ? (
              <p className="px-1 py-8 text-center text-[12px] text-muted-foreground">
                Pick servers on the left, write a command, and run it.
                <br />
                Each server reports on its own.
              </p>
            ) : null}
            <div className="space-y-2">
              {hosts.map((host) => (
                <HostCard key={host.connectionId} host={host} />
              ))}
            </div>
          </div>
        </section>
      </div>

      {/*
        Pinned outside every scrolling region. The action you came here to take
        cannot be scrolled away from, which is the whole reason this stopped
        being a dialog.
      */}
      <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-chrome px-3 py-2">
        <Button onClick={() => void launch(false)} disabled={!canRun} className="gap-1.5 text-[12px]">
          <Play className="size-3.5" />
          Run on {selected.size} server{selected.size === 1 ? '' : 's'}
        </Button>
        {running ? (
          <Button
            variant="destructive"
            onClick={() => runId && void api()?.fleet.cancel(runId)}
            className="gap-1.5 text-[12px]"
          >
            <Square className="size-3.5" />
            Stop
          </Button>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void check()}
          disabled={selected.size === 0 || running || checking}
          className="gap-1.5 text-[12px]"
        >
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Check for updates
        </Button>

        <div className="ml-auto flex items-center gap-2.5 text-[11.5px]">
          {running ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {hosts.filter((host) => host.state === 'running').length} running ·{' '}
              {hosts.filter((host) => host.state !== 'pending' && host.state !== 'running').length}/{hosts.length} done
            </span>
          ) : null}
          {finished ? (
            <Badge variant={finished.failed > 0 ? 'destructive' : 'secondary'}>
              {finished.succeeded} ok · {finished.failed} failed
              {finished.skipped > 0 ? ` · ${finished.skipped} not run` : ''}
            </Badge>
          ) : null}
        </div>
      </footer>

      <HazardDialog
        hazards={hazards}
        serverCount={selected.size}
        onCancel={() => setHazards([])}
        onConfirm={() => void launch(true)}
      />
    </div>
  )
}

/**
 * A real modal, for the one genuinely modal thing here: a yes/no you must
 * answer before anything happens.
 */
function HazardDialog({
  hazards,
  serverCount,
  onCancel,
  onConfirm,
}: {
  hazards: readonly Hazard[]
  serverCount: number
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={hazards.length > 0} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-lg">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h2 className="text-[14px] font-medium">This can destroy a server</h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              It would run on {serverCount} server{serverCount === 1 ? '' : 's'}.
            </p>
          </div>
        </div>

        <ul className="my-3 max-h-[40vh] space-y-2 overflow-y-auto text-[12.5px]">
          {hazards.map((hazard) => (
            <li key={`${hazard.lineNumber}-${hazard.kind}`}>
              <span className="text-faint">line {hazard.lineNumber}:</span> {hazard.explanation}
              <code className="selectable mt-0.5 block overflow-x-auto rounded bg-secondary px-1.5 py-1 font-[family-name:var(--font-mono)] text-[11px]">
                {hazard.line}
              </code>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} className="text-[12px]">
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} className="text-[12px]">
            Run it anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function HostCard({ host }: { host: HostView }) {
  const meta = STATE_META[host.state]
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 bg-chrome px-2.5 py-1.5 text-[12px]">
        <span className={meta.tone}>{meta.icon}</span>
        <span className="font-medium">{host.name}</span>
        <span className="truncate text-faint">{host.host}</span>
        <span className={`ml-auto shrink-0 ${meta.tone}`}>{meta.label}</span>
        {host.exitCode !== null && host.exitCode !== 0 ? (
          <span className="numeric shrink-0 text-destructive">exit {host.exitCode}</span>
        ) : null}
        {host.durationMs !== null ? (
          <span className="numeric shrink-0 text-faint">{(host.durationMs / 1000).toFixed(1)}s</span>
        ) : null}
      </div>

      {host.errorSummary ? (
        <p className="selectable flex items-start gap-1.5 border-t border-line bg-danger-surface px-2.5 py-1.5 text-[11.5px] text-danger-ink">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
          {host.errorSummary}
        </p>
      ) : null}

      {host.lines.length > 0 ? (
        <pre className="selectable max-h-[220px] overflow-auto bg-background px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.55] text-dim">
          {host.lines.join('\n')}
        </pre>
      ) : null}
    </div>
  )
}

function UpdateReportTable({ reports }: { reports: readonly HostUpdateReport[] }) {
  return (
    <div className="mb-3 overflow-x-auto rounded-md border border-line">
      <table className="w-full text-[11.5px]">
        <thead className="bg-chrome text-faint">
          <tr>
            {['Server', 'OS', 'Updates', 'Security', 'Reboot', 'Disk'].map((heading) => (
              <th key={heading} className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr key={report.connectionId} className="border-t border-line">
              <td className="px-2.5 py-1.5">{report.connectionName}</td>
              <td className="px-2.5 py-1.5 text-muted-foreground">
                {report.reachable ? (report.os ?? 'unknown') : (report.error ?? 'unreachable')}
              </td>
              {/* A count DiskPush could not obtain shows as "?" and never as 0:
                  "no updates pending" is a claim, and it has to be earned. */}
              <td className="numeric px-2.5 py-1.5">{report.updates === null ? '?' : report.updates}</td>
              <td className="numeric px-2.5 py-1.5">
                {report.securityUpdates === null ? '—' : report.securityUpdates}
              </td>
              <td className="px-2.5 py-1.5">
                {report.rebootRequired === null ? '?' : report.rebootRequired ? (
                  <span className="text-warn">yes</span>
                ) : (
                  'no'
                )}
              </td>
              <td className="numeric px-2.5 py-1.5">
                {report.diskUsedPercent === null ? '—' : `${report.diskUsedPercent}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function applyEvent(
  event: FleetEvent,
  setHosts: React.Dispatch<React.SetStateAction<HostView[]>>,
  setFinished: React.Dispatch<React.SetStateAction<{ succeeded: number; failed: number; skipped: number } | null>>,
  setError: (message: string) => void,
): void {
  if (event.type === 'run-error') {
    setError(event.message)
    setFinished({ succeeded: 0, failed: 0, skipped: 0 })
    return
  }
  if (event.type === 'run-exit') {
    setFinished({ succeeded: event.succeeded, failed: event.failed, skipped: event.skipped })
    return
  }
  setHosts((current) => foldHosts(current, event))
}
