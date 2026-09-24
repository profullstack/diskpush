'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, Puzzle, ShieldAlert } from 'lucide-react'
import {
  api,
  unwrap,
  type PluginEvent,
  type PluginSettingDef,
  type PluginSettingsState,
  type PluginSummary,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

type Draft = Record<string, string | boolean>

/** One setting's control. A secret is write-only: typed in, never shown back. */
function SettingField({
  def,
  value,
  secretSet,
  onChange,
}: {
  def: PluginSettingDef
  value: string | boolean | undefined
  secretSet: boolean
  onChange: (value: string | boolean) => void
}) {
  const id = `plugin-setting-${def.key}`
  if (def.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-[12px] text-dim">
        <Checkbox checked={value === true} onCheckedChange={(next) => onChange(next === true)} />
        {def.label}
      </label>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[10.5px] uppercase tracking-[0.08em] text-faint">
        {def.label}
      </Label>
      {def.type === 'enum' ? (
        <select
          id={id}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className="focus-ring h-[var(--control)] rounded-md border border-line bg-background px-2 text-[12px] text-foreground"
        >
          {(def.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option === '' ? 'Automatic' : option}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type={def.type === 'secret' ? 'password' : 'text'}
          autoComplete="off"
          value={String(value ?? '')}
          placeholder={def.type === 'secret' ? (secretSet ? 'Saved. Type to replace; clear to remove.' : 'Not set') : ''}
          onChange={(event) => onChange(event.target.value)}
          className="h-[var(--control)] text-[12px]"
        />
      )}
      {def.description ? <p className="text-[11px] leading-relaxed text-faint">{def.description}</p> : null}
    </div>
  )
}

/**
 * One plugin: on or off, what it says about itself (signed in as whom), its
 * tasks as buttons, and its settings.
 */
function PluginCard({ plugin, onToggled }: { plugin: PluginSummary; onToggled: () => void }) {
  const [state, setState] = useState<PluginSettingsState | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' | 'info' } | null>(null)
  const [task, setTask] = useState<{ jobId: string; label: string } | null>(null)
  const taskRef = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await unwrap(api()?.plugins.getSettings(plugin.id))
      setState(next)
      setDraft(next.values)
      setTouched(new Set())
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : String(caught), tone: 'error' })
    }
  }, [plugin.id])

  useEffect(() => {
    void load()
  }, [load, plugin.enabled])

  // A task (signing in) runs in the main process and ends with an exit event.
  useEffect(() => {
    const bridge = api()
    if (!bridge) return
    return bridge.events.onPluginProgress(({ jobId, event }: { jobId: string; event: PluginEvent }) => {
      if (jobId !== taskRef.current) return
      if (event.type === 'update' && event.message) setMessage({ text: event.message, tone: 'info' })
      if (event.type === 'exit') {
        taskRef.current = null
        setTask(null)
        setMessage({ text: event.message, tone: event.ok ? 'ok' : 'error' })
        void load()
      }
    })
  }, [load])

  const runTask = async (taskId: string, label: string) => {
    const jobId = crypto.randomUUID()
    taskRef.current = jobId
    setTask({ jobId, label })
    setMessage(null)
    try {
      await unwrap(api()?.plugins.runTask(jobId, plugin.id, taskId))
    } catch (caught) {
      taskRef.current = null
      setTask(null)
      setMessage({ text: caught instanceof Error ? caught.message : String(caught), tone: 'error' })
    }
  }

  const save = async () => {
    const values: Record<string, string | boolean | null> = {}
    for (const key of touched) {
      const def = plugin.settings.find((candidate) => candidate.key === key)
      const value = draft[key]
      if (!def || value === undefined) continue
      values[key] = def.type === 'secret' && value === '' ? null : value
    }
    try {
      await unwrap(api()?.plugins.setSettings(plugin.id, values))
      setMessage({ text: 'Saved.', tone: 'ok' })
      await load()
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : String(caught), tone: 'error' })
    }
  }

  const toggle = async (enabled: boolean) => {
    try {
      await unwrap(api()?.plugins.setEnabled(plugin.id, enabled))
      onToggled()
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : String(caught), tone: 'error' })
    }
  }

  return (
    <section className="rounded-xl border border-line bg-card p-4">
      <header className="flex items-start gap-3">
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-info-surface text-primary">
          <Puzzle className="size-[16px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            {plugin.name}
            <span className="numeric text-[11px] font-normal text-faint">{plugin.version}</span>
            {plugin.source === 'external' ? (
              <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn">external</span>
            ) : null}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{plugin.description}</p>
          {plugin.enabled && state?.status ? <p className="selectable mt-1 text-[11.5px] text-dim">{state.status}</p> : null}
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Checkbox checked={plugin.enabled} onCheckedChange={(next) => void toggle(next === true)} />
          Enabled
        </label>
      </header>

      {plugin.enabled ? (
        <>
          {plugin.tasks.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {plugin.tasks.map((item, index) => (
                <Button
                  key={item.id}
                  variant={index === 0 ? 'default' : 'outline'}
                  disabled={task !== null}
                  onClick={() => void runTask(item.id, item.label)}
                  className="h-[30px] text-[12px]"
                >
                  {task?.label === item.label ? `${item.label}…` : item.label}
                </Button>
              ))}
              {task ? (
                <Button
                  variant="ghost"
                  onClick={() => void api()?.plugins.cancel(task.jobId)}
                  className="h-[30px] text-[12px] text-muted-foreground"
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}

          {plugin.settings.length > 0 ? (
            <div className="mt-4 flex flex-col gap-3">
              {plugin.settings.map((def) => (
                <SettingField
                  key={def.key}
                  def={def}
                  value={draft[def.key]}
                  secretSet={state?.secrets[def.key] === true}
                  onChange={(value) => {
                    setDraft((current) => ({ ...current, [def.key]: value }))
                    setTouched((current) => new Set(current).add(def.key))
                  }}
                />
              ))}
              <div className="flex justify-end">
                <Button onClick={() => void save()} disabled={touched.size === 0} className="h-[30px] text-[12px]">
                  Save settings
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {message ? (
        <p
          className={cn(
            'selectable mt-3 text-[11.5px]',
            message.tone === 'error' ? 'text-destructive' : message.tone === 'ok' ? 'text-ok' : 'text-muted-foreground',
          )}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Plugins…: what is installed, on and off, and each one's settings.
 *
 * Plugins run in the main process with your privileges; the note at the top
 * says so, because an external plugin is a program, not a theme.
 */
export function PluginsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [failures, setFailures] = useState<{ name: string; error: string }[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await unwrap(api()?.plugins.list())
      setPlugins(result.plugins)
      setFailures(result.failures)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-xl gap-0 border-line-strong bg-popover p-0 [--dialog-pad:0px]">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-[18px] py-4">
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-info-surface text-primary">
            <Puzzle className="size-[17px]" />
          </span>
          <DialogTitle className="text-[14px]">Plugins</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="flex flex-col gap-3 px-[18px] py-4">
            <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
              <span>
                Plugins run inside DiskPush with your privileges. Their actions are in a local file&apos;s right-click
                menu, and as <span className="numeric">diskpush &lt;plugin&gt;</span> commands in the CLI.
              </span>
            </div>
            {error ? (
              <p className="selectable rounded-lg border border-danger-line bg-danger-surface px-3 py-2 text-[12px] text-danger-ink">
                {error}
              </p>
            ) : null}
            {plugins.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} onToggled={() => void refresh()} />
            ))}
            {failures.map((failure) => (
              <p key={failure.name} className="flex items-start gap-2 text-[11.5px] text-danger-ink">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="selectable">
                  {failure.name} did not load: {failure.error}
                </span>
              </p>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
