'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Brush, CircleAlert, Copy, Loader2, Search, ShieldAlert, ShieldCheck, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatBytes } from '@/lib/format'
import { api, unwrap, type CleanerApplyResult, type CleanerItem, type CleanerReport, type CleanerTarget } from '@/lib/api'
import { CLEANER_CATEGORIES, categoryLabel, plannedItems, selectedBytes, sizeLabel } from '@/lib/cleaner'

/**
 * Cleaner — free disk space intelligently, on this machine or any server.
 *
 * Analyze first: filesystems, who is writing right now, the biggest
 * directories, growth since the last analysis, and every finding classified
 * (safe / safe-if-idle / needs a human) with the reason. Then tick what to
 * remove and confirm. Only safe-class items can be ticked; needs-a-human items
 * show a command to look closer and are never removed from here.
 */

const SAFETY_BADGE: Record<CleanerItem['safety'], string> = {
  safe: 'bg-ok/15 text-ok',
  'safe-if-idle': 'bg-primary/15 text-primary',
  human: 'bg-destructive/10 text-destructive',
}

export function CleanerPanel() {
  const [targets, setTargets] = useState<CleanerTarget[]>([])
  const [target, setTarget] = useState('local')
  const [only, setOnly] = useState<Set<string>>(new Set(CLEANER_CATEGORIES))
  const [report, setReport] = useState<CleanerReport | null>(null)
  const [reportId, setReportId] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [jobId, setJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState<'scan' | 'apply' | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<CleanerApplyResult | null>(null)
  const jobRef = useRef<string | null>(null)

  useEffect(() => {
    void unwrap(api()?.cleaner.targets())
      .then(setTargets)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [])

  useEffect(() => {
    const off = api()?.events.onPluginProgress(({ jobId: id, event }) => {
      if (id !== jobRef.current) return
      if (event.type === 'update' && event.message) setStatus(event.message)
      if (event.type === 'log') setStatus(event.message)
    })
    return off
  }, [])

  const analyze = useCallback(async () => {
    const id = crypto.randomUUID()
    jobRef.current = id
    setJobId(id)
    setBusy('scan')
    setError(null)
    setResult(null)
    setStatus(`Scanning ${target}…`)
    try {
      const out = await unwrap(api()?.cleaner.scan(id, target, only.size === CLEANER_CATEGORIES.length ? [] : [...only]))
      setReport(out.report)
      setReportId(out.reportId)
      setChosen(new Set(plannedItems(out.report).map((i) => i.id)))
      setStatus('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }, [target, only])

  const apply = useCallback(async () => {
    if (!reportId || !chosen.size) return
    setConfirming(false)
    const id = crypto.randomUUID()
    jobRef.current = id
    setJobId(id)
    setBusy('apply')
    setError(null)
    setStatus('Removing…')
    try {
      const out = await unwrap(api()?.cleaner.apply(id, reportId, [...chosen]))
      setResult(out)
      setReportId(null)
      setStatus('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }, [reportId, chosen])

  const cancel = useCallback(async () => {
    if (jobId) await api()?.cleaner.cancel(jobId)
  }, [jobId])

  const items = report?.items ?? []
  const eligible = useMemo(() => items.filter((i) => i.eligible && i.safety !== 'human'), [items])
  const kept = useMemo(() => items.filter((i) => !i.eligible && i.safety !== 'human'), [items])
  const human = useMemo(() => items.filter((i) => i.safety === 'human'), [items])
  const total = useMemo(() => selectedBytes(items, chosen), [items, chosen])

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Brush className="size-4 text-primary" />
        Free disk space
        <span className="font-normal text-faint">· analysis first; only safe items can be removed, and only after you confirm</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-faint" htmlFor="cleaner-target">
          Target
        </label>
        <select
          id="cleaner-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy !== null}
          className="h-[var(--control)] rounded-md border border-line-strong bg-background px-2 text-[12px]"
        >
          {(targets.length ? targets : [{ name: 'local', local: true, host: null, usable: true, reason: null }]).map((t) => (
            <option key={t.name} value={t.name} disabled={!t.usable}>
              {t.local ? 'This machine' : t.name}
              {t.host && !t.local ? ` (${t.host})` : ''}
              {t.usable ? '' : ' — needs a key'}
            </option>
          ))}
        </select>
        {CLEANER_CATEGORIES.map((c) => (
          <label key={c} className="flex cursor-pointer items-center gap-1.5 text-[12px]">
            <Checkbox
              checked={only.has(c)}
              disabled={busy !== null}
              onCheckedChange={() =>
                setOnly((cur) => {
                  const next = new Set(cur)
                  if (next.has(c)) next.delete(c)
                  else next.add(c)
                  return next.size ? next : cur
                })
              }
            />
            {categoryLabel(c)}
          </label>
        ))}
        <Button onClick={() => void analyze()} disabled={busy !== null} className="h-[var(--control)] gap-2 text-[12px]">
          {busy === 'scan' ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          Analyze
        </Button>
        {busy ? (
          <Button variant="outline" onClick={() => void cancel()} className="h-[var(--control)] gap-2 text-[12px]">
            <Square className="size-3.5" />
            Cancel
          </Button>
        ) : null}
        {status ? <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{status}</span> : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[12px] text-destructive selectable" role="alert">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {result ? <ApplySummary result={result} items={items} /> : null}

      <ScrollArea className="min-h-0 flex-1 rounded-md border border-line">
        {!report ? (
          <div className="px-3 py-4 text-[12px] text-faint">
            Pick a target and Analyze. Nothing is deleted until you tick items and confirm.
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-3 text-[12px]">
            <Overview report={report} />

            <section>
              <div className="mb-1 flex items-center gap-2 font-medium">
                <ShieldCheck className="size-3.5 text-ok" />
                Can be freed safely · {eligible.length} item{eligible.length === 1 ? '' : 's'}
                <span className="font-normal text-faint">ranked by bytes freed per unit of risk</span>
                <span className="ml-auto flex gap-2 font-normal">
                  <button className="text-primary hover:underline" onClick={() => setChosen(new Set(eligible.map((i) => i.id)))}>
                    all
                  </button>
                  <button className="text-primary hover:underline" onClick={() => setChosen(new Set())}>
                    none
                  </button>
                </span>
              </div>
              {eligible.length === 0 ? <p className="text-faint">Nothing can be freed safely right now.</p> : null}
              <ul className="divide-y divide-line rounded-md border border-line">
                {eligible.map((i) => (
                  <li key={i.id} className="flex items-start gap-2 px-2 py-1.5">
                    <Checkbox className="mt-0.5" checked={chosen.has(i.id)} onCheckedChange={() => toggle(i.id)} aria-label={`Remove ${i.title}`} />
                    <ItemRow item={i} />
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="destructive"
                  disabled={!chosen.size || !reportId || busy !== null}
                  onClick={() => setConfirming(true)}
                  className="h-[var(--control)] gap-2 text-[12px]"
                >
                  {busy === 'apply' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  Free about {formatBytes(total)}…
                </Button>
                {!reportId && result ? <span className="text-faint">Analyze again to see the new state.</span> : null}
              </div>
            </section>

            {kept.length || report.kept.length ? (
              <section>
                <div className="mb-1 font-medium">Kept, and why</div>
                <ul className="space-y-1 text-faint">
                  {kept.map((i) => (
                    <li key={i.id}>
                      <span className="tabular-nums text-foreground">{sizeLabel(i)}</span> {i.title}: {i.why.replace(/^Kept: /, '')}
                    </li>
                  ))}
                  {report.kept.slice(0, 50).map((k) => (
                    <li key={`${k.root}-${k.reason}`} className="selectable">
                      <span className="font-mono">{k.root}</span>: {k.reason}
                      {k.dirs > 1 ? ` (${k.dirs} build dirs)` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {human.length ? (
              <section>
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-3.5 text-destructive" />
                  Needs a human · reported, never removed from here
                </div>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {human.map((i) => (
                    <li key={i.id} className="px-2 py-1.5">
                      <ItemRow item={i} />
                      {i.suggested ? <CommandLine command={i.suggested} /> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {report.warnings.map((w) => (
              <p key={w} className="text-[12px] text-destructive">
                {w}
              </p>
            ))}
          </div>
        )}
      </ScrollArea>

      <Dialog open={confirming} onOpenChange={(next) => !next && setConfirming(false)}>
        <DialogContent className="max-w-lg">
          <div className="flex items-start gap-2.5">
            <Trash2 className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <h2 className="text-[14px] font-medium">
                Remove {chosen.size} item{chosen.size === 1 ? '' : 's'} on {report?.target === 'local' ? 'this machine' : report?.target}?
              </h2>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                About {formatBytes(total)}. Each item is checked again on the target as it goes: anything that became busy since the analysis is skipped.
              </p>
            </div>
          </div>
          <ul className="my-3 max-h-[40vh] space-y-1 overflow-y-auto text-[12px]">
            {items
              .filter((i) => chosen.has(i.id))
              .map((i) => (
                <li key={i.id} className="flex gap-2">
                  <span className="w-20 shrink-0 text-right tabular-nums">{sizeLabel(i)}</span>
                  <span className="truncate" title={i.title}>
                    {i.title}
                  </span>
                </li>
              ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)} className="text-[12px]" autoFocus>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void apply()} className="text-[12px]">
              Remove them
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ItemRow({ item }: { item: CleanerItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-right tabular-nums">{sizeLabel(item)}</span>
        <span className={`shrink-0 rounded px-1.5 text-[10.5px] ${SAFETY_BADGE[item.safety]}`}>{item.safety === 'human' ? 'needs a human' : item.safety}</span>
        <span className="truncate selectable" title={item.path ?? item.title}>
          {item.title}
        </span>
      </div>
      <p className="ml-[5.5rem] text-[11.5px] text-faint">{item.why}</p>
    </div>
  )
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="ml-[5.5rem] mt-1 flex items-center gap-2">
      <code className="selectable min-w-0 flex-1 overflow-x-auto rounded bg-secondary px-1.5 py-1 font-[family-name:var(--font-mono)] text-[11px]">{command}</code>
      <Button
        variant="outline"
        size="sm"
        className="h-6 shrink-0 gap-1 text-[11px]"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        <Copy className="size-3" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function Overview({ report }: { report: CleanerReport }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <section>
        <div className="mb-1 font-medium">Filesystems</div>
        <ul className="space-y-1">
          {report.filesystems.slice(0, 6).map((f) => {
            const grow = report.growth?.fs.find((g) => g.mount === f.mount)
            return (
              <li key={f.mount}>
                <div className="flex items-center gap-2">
                  <span className="w-28 truncate font-mono" title={f.mount}>
                    {f.mount}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-secondary">
                    <div className={`h-full ${f.usedPercent >= 90 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${f.usedPercent}%` }} />
                  </div>
                  <span className="w-28 text-right tabular-nums text-faint">{formatBytes(f.availBytes)} free</span>
                </div>
                {grow && grow.deltaBytes !== 0 ? (
                  <div className="ml-[7.5rem] text-[11px] text-faint">
                    {grow.deltaBytes > 0 ? '+' : '−'}
                    {formatBytes(Math.abs(grow.deltaBytes))} since the last analysis ({grow.bytesPerHour >= 0 ? '+' : '−'}
                    {formatBytes(Math.abs(grow.bytesPerHour))}/h)
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        {report.writers.length ? (
          <>
            <div className="mb-1 mt-3 font-medium">Writing to disk right now</div>
            <ul className="space-y-0.5">
              {report.writers.slice(0, 6).map((w) => (
                <li key={w.pid} className="flex gap-2" title={w.cmdline}>
                  <span className="w-24 shrink-0 text-right tabular-nums">{formatBytes(w.bytesPerSecond)}/s</span>
                  <span className="truncate">
                    {w.command}
                    {w.container ? <span className="text-faint"> · container {w.container}</span> : null}
                    <span className="text-faint"> · pid {w.pid}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <section>
        <div className="mb-1 font-medium">Biggest directories</div>
        <ul className="space-y-0.5">
          {report.topDirs.slice(0, 12).map((d) => (
            <li key={d.path} className="flex gap-2">
              <span className="w-20 shrink-0 text-right tabular-nums">{d.bytes < 0 ? '?' : `${d.timedOut ? '≥ ' : ''}${formatBytes(d.bytes)}`}</span>
              <span className="truncate font-mono selectable" title={d.path}>
                {d.path}
              </span>
              {d.kind ? <span className="shrink-0 text-faint">[{d.kind}]</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function ApplySummary({ result, items }: { result: CleanerApplyResult; items: CleanerItem[] }) {
  const titles = new Map(items.map((i) => [i.id, i.title]))
  const problems = result.results.filter((r) => r.status === 'failed' || r.status === 'skipped')
  return (
    <div className="rounded-md border border-line bg-secondary/40 p-2 text-[12px]" role="status">
      {result.locked ? (
        <p>Another clean is already running on this target; nothing was done.</p>
      ) : (
        <p className="font-medium">
          Freed about {formatBytes(result.freedBytes)} · {result.results.filter((r) => r.status === 'ok').length} removed
          {problems.length ? ` · ${problems.length} skipped` : ''}
          {result.stopped ? ' · stopped once enough space was free' : ''}
        </p>
      )}
      {problems.length ? (
        <ul className="mt-1 space-y-0.5 text-faint">
          {problems.map((r) => (
            <li key={r.id}>
              {titles.get(r.id) ?? r.id}: {r.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
