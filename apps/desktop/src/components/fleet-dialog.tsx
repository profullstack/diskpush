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
  Server,
  ShieldAlert,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { blankHost, foldHosts, type HostView } from '@/lib/fleet-events'
import {
  api,
  unwrap,
  type Connection,
  type FleetCommand,
  type FleetEvent,
  type FleetHostState,
  type Hazard,
  type HostUpdateReport,
} from '@/lib/api'

/**
 * Fleet — one command, many servers.
 *
 * The two-pane view answers "move these bytes there". This answers "do this
 * on all of those", and it is built around the same bargain: show exactly
 * what will run and exactly where, before it runs, and report each server
 * separately afterwards. A run is never summarised as "done" on behalf of a
 * host that did not say so.
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

export function FleetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [servers, setServers] = useState<Connection[]>([])
  const [commands, setCommands] = useState<FleetCommand[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  const [script, setScript] = useState('')
  const [label, setLabel] = useState('')
  const [commandId, setCommandId] = useState<string | null>(null)
  const [interpreter, setInterpreter] = useState<'sh' | 'bash' | 'raw'>('raw')
  const [sudo, setSudo] = useState(false)
  const [sudoPassword, setSudoPassword] = useState('')
  const [askSudoPassword, setAskSudoPassword] = useState(false)
  const [concurrency, setConcurrency] = useState(4)
  const [timeoutSeconds, setTimeoutSeconds] = useState(900)
  const [stopOnError, setStopOnError] = useState(false)

  const [hazards, setHazards] = useState<Hazard[]>([])
  const [hazardsConfirmed, setHazardsConfirmed] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [hosts, setHosts] = useState<HostView[]>([])
  const [checking, setChecking] = useState(false)
  const [reports, setReports] = useState<HostUpdateReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState<{ succeeded: number; failed: number; skipped: number } | null>(null)

  const running = runId !== null && finished === null
  const logRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [serverList, commandList] = await Promise.all([
        unwrap(api()?.fleet.servers()),
        unwrap(api()?.fleet.commands()),
      ])
      setServers(serverList)
      setCommands(commandList)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // One subscription for the life of the dialog. Events for a run other than
  // the one on screen are ignored rather than merged, so reopening the dialog
  // mid-run does not paint someone else's output into this one.
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
    // reader put it: yanking them back to the bottom of a finished run is how
    // you lose the line you were reading.
    if (running && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
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
      const everyOn = visible.every((server) => next.has(server.id))
      for (const server of visible) {
        if (everyOn) next.delete(server.id)
        else next.add(server.id)
      }
      return next
    })

  const pickCommand = (command: FleetCommand) => {
    setScript(command.script)
    setLabel(command.name)
    setCommandId(command.builtin ? null : command.id)
    setInterpreter(command.interpreter)
    setSudo(command.sudo)
    setTimeoutSeconds(command.timeoutSeconds)
    setHazards([])
    setHazardsConfirmed(false)
  }

  const requestBody = useCallback(
    () => ({
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
      hazardsConfirmed,
      commandId,
      label,
    ],
  )

  const start = useCallback(async () => {
    setError(null)
    setFinished(null)
    setReports(null)

    try {
      // Preview first, always. It is the only thing standing between a typo
      // and forty servers, and it costs one round trip with no side effects.
      const preview = await unwrap(api()?.fleet.preview(requestBody()))
      if (preview.hazards.length > 0 && !hazardsConfirmed) {
        setHazards(preview.hazards)
        return
      }

      setHosts(preview.servers.map(blankHost))
      const started = await unwrap(api()?.fleet.start(requestBody()))
      setRunId(started.runId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [requestBody, hazardsConfirmed])

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

  const reset = () => {
    setRunId(null)
    setHosts([])
    setFinished(null)
    setHazards([])
    setHazardsConfirmed(false)
  }

  const canRun = selected.size > 0 && script.trim().length > 0 && !running

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[86vh] w-[min(1180px,94vw)] max-w-none flex-col gap-0 p-0">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <Server className="size-4 text-muted-foreground" />
          <div>
            <h2 className="text-[13px] font-medium">Fleet</h2>
            <p className="text-[11px] text-muted-foreground">Run one command on many servers.</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} className="gap-1.5 text-[12px]">
              <RefreshCw className="size-3.5" />
              Reload servers
            </Button>
          </div>
        </header>

        {error ? (
          <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-surface px-4 py-2 text-[12px] text-danger-ink">
            <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
            <span className="selectable">{error}</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {/* --- servers ------------------------------------------------- */}
          <aside className="flex w-[268px] shrink-0 flex-col border-r border-line">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
                Servers · {selected.size}/{servers.length}
              </span>
              <Button variant="ghost" size="xs" onClick={selectAllVisible} className="text-[11px]">
                {visible.every((server) => selected.has(server.id)) && visible.length > 0 ? 'None' : 'All'}
              </Button>
            </div>

            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-1 px-3 pb-2">
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
                  <p className="px-2 py-4 text-[12px] text-muted-foreground">
                    No servers yet. Add one, or import ~/.ssh/config.
                  </p>
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

          {/* --- command and results ------------------------------------- */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-line p-3">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] text-faint">Recipes:</span>
                {commands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    title={command.description}
                    onClick={() => pickCommand(command)}
                    disabled={running}
                    className="focus-ring rounded-md border border-line-strong px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                  >
                    {command.name}
                  </button>
                ))}
              </div>

              <Textarea
                value={script}
                onChange={(event) => {
                  setScript(event.target.value)
                  setHazards([])
                  setHazardsConfirmed(false)
                  setCommandId(null)
                }}
                disabled={running}
                rows={5}
                spellCheck={false}
                placeholder="systemctl reload nginx"
                className="font-[family-name:var(--font-mono)] text-[12px]"
              />

              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
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
                    className="h-7 w-[160px] text-[12px]"
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
                    className="h-7 w-[58px] text-[12px]"
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
                    className="h-7 w-[72px] text-[12px]"
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

              {hazards.length > 0 ? (
                <div className="mt-2.5 rounded-md border border-danger-line bg-danger-surface p-2.5 text-[12px]">
                  <p className="mb-1.5 flex items-center gap-1.5 font-medium text-danger-ink">
                    <ShieldAlert className="size-3.5 text-destructive" />
                    This can destroy a server, and it would run on {selected.size}.
                  </p>
                  <ul className="mb-2 space-y-1 text-danger-ink">
                    {hazards.map((hazard) => (
                      <li key={`${hazard.lineNumber}-${hazard.kind}`}>
                        <span className="text-faint">line {hazard.lineNumber}:</span> {hazard.explanation}
                        <code className="selectable ml-1 block truncate font-[family-name:var(--font-mono)] text-[11px]">
                          {hazard.line}
                        </code>
                      </li>
                    ))}
                  </ul>
                  <label className="group/field flex items-center gap-1.5 text-danger-ink">
                    <Checkbox
                      checked={hazardsConfirmed}
                      onCheckedChange={() => setHazardsConfirmed((value) => !value)}
                    />
                    <span>I know what this does. Run it on all {selected.size} servers.</span>
                  </label>
                </div>
              ) : null}

              <div className="mt-2.5 flex items-center gap-2">
                <Button onClick={() => void start()} disabled={!canRun} className="gap-1.5 text-[12px]">
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
                {finished ? (
                  <Button variant="ghost" onClick={reset} className="text-[12px]">
                    Clear
                  </Button>
                ) : null}
                {finished ? (
                  <span className="ml-auto flex items-center gap-2 text-[12px]">
                    <Badge variant={finished.failed > 0 ? 'destructive' : 'secondary'}>
                      {finished.succeeded} ok · {finished.failed} failed
                      {finished.skipped > 0 ? ` · ${finished.skipped} not run` : ''}
                    </Badge>
                  </span>
                ) : null}
              </div>
            </div>

            <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto p-3">
              {reports ? <UpdateReportTable reports={reports} /> : null}
              {hosts.length === 0 && !reports ? (
                <p className="px-1 py-6 text-center text-[12px] text-muted-foreground">
                  Pick servers on the left, type a command, and run it. Each server reports on its own.
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
        <span className="text-faint">{host.host}</span>
        <span className={`ml-auto ${meta.tone}`}>{meta.label}</span>
        {host.exitCode !== null && host.exitCode !== 0 ? (
          <span className="numeric text-destructive">exit {host.exitCode}</span>
        ) : null}
        {host.durationMs !== null ? (
          <span className="numeric text-faint">{(host.durationMs / 1000).toFixed(1)}s</span>
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
    <div className="mb-3 overflow-hidden rounded-md border border-line">
      <table className="w-full text-[11.5px]">
        <thead className="bg-chrome text-faint">
          <tr>
            {['Server', 'OS', 'Updates', 'Security', 'Reboot', 'Disk'].map((heading) => (
              <th key={heading} className="px-2.5 py-1.5 text-left font-medium">
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

/** Routes one event to the right piece of state. */
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
