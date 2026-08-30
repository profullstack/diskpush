'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleAlert, Copy, FileDown, Plus, Search, Server, ShieldCheck, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, unwrap, type Connection } from '@/lib/api'

/**
 * The server manager: browse everything you have saved, and edit any of it.
 *
 * The app could *create* a connection and nothing else — no list, no edit, no
 * delete. Every field beyond the six in the New-server dialog was unreachable,
 * `tags` most consequentially: fleet selection is built on `tag:production`
 * and there was nowhere to set one.
 *
 * Servers are shared by both surfaces, so this is one manager rather than two:
 * the same list backs the transfer panes and the Fleet view.
 *
 * `~/.ssh/config` hosts are listed but not editable — they are somebody else's
 * file. "Save a copy" turns one into a connection of your own, which is the
 * same deliberate act the CLI's import performs.
 */

type Draft = {
  id: string | null
  name: string
  host: string
  port: string
  username: string
  authType: 'agent' | 'key'
  keyPath: string
  defaultRemotePath: string
  jumpHost: string
  rsyncPath: string
  tags: string
  notes: string
  forwardAgent: boolean
}

const BLANK: Draft = {
  id: null,
  name: '',
  host: '',
  port: '22',
  username: '',
  authType: 'agent',
  keyPath: '',
  defaultRemotePath: '',
  jumpHost: '',
  rsyncPath: '',
  tags: '',
  notes: '',
  forwardAgent: false,
}

function toDraft(connection: Connection): Draft {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: String(connection.port),
    username: connection.username,
    authType: connection.authType === 'key' ? 'key' : 'agent',
    keyPath: connection.keyPath ?? '',
    defaultRemotePath: connection.defaultRemotePath ?? '',
    jumpHost: connection.jumpHost ?? '',
    rsyncPath: connection.rsyncPath ?? '',
    tags: (connection.tags ?? []).join(', '),
    notes: connection.notes ?? '',
    forwardAgent: connection.forwardAgent ?? false,
  }
}

export function ServerManager({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [saved, setSaved] = useState<Connection[]>([])
  const [sshConfig, setSshConfig] = useState<Connection[]>([])
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<Draft>(BLANK)
  /** Null while editing an ssh_config host, which is read-only. */
  const [readOnly, setReadOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [list, hosts] = await Promise.all([
        unwrap(api()?.connections.list()),
        unwrap(api()?.connections.sshConfigHosts()),
      ])
      setSaved(list)
      setSshConfig(hosts)
      return list
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return []
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const list = await refresh()
      // Land on something rather than an empty form: the first server if there
      // is one, otherwise a blank ready to fill in.
      setDraft(list[0] ? toDraft(list[0]) : BLANK)
      setReadOnly(false)
      setError(null)
      setProbe(null)
    })()
  }, [open, refresh])

  const matches = useCallback(
    (connection: Connection) => {
      const needle = filter.trim().toLowerCase()
      if (!needle) return true
      return [connection.name, connection.host, connection.username, ...(connection.tags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    },
    [filter],
  )

  const visibleSaved = useMemo(() => saved.filter(matches), [saved, matches])
  const visibleConfig = useMemo(() => sshConfig.filter(matches), [sshConfig, matches])

  const select = (connection: Connection, fromSshConfig: boolean) => {
    setDraft(toDraft(connection))
    setReadOnly(fromSshConfig)
    setError(null)
    setProbe(null)
  }

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = await unwrap(
        api()?.connections.save({
          // Present when editing, absent when creating. The store upserts on
          // it, so an edit never leaves a second copy behind.
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim(),
          host: draft.host.trim(),
          username: draft.username.trim(),
          port: Number(draft.port) || 22,
          authType: draft.authType,
          keyPath: draft.authType === 'key' ? draft.keyPath.trim() || null : null,
          defaultRemotePath: draft.defaultRemotePath.trim() || null,
          jumpHost: draft.jumpHost.trim() || null,
          rsyncPath: draft.rsyncPath.trim() || null,
          forwardAgent: draft.forwardAgent,
          tags: draft.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          notes: draft.notes,
        }),
      )
      setDraft(toDraft(saved))
      setReadOnly(false)
      await refresh()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [draft, refresh, onChanged])

  const remove = useCallback(async () => {
    if (!draft.id) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(api()?.connections.remove(draft.id))
      const list = await refresh()
      setDraft(list[0] ? toDraft(list[0]) : BLANK)
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [draft.id, refresh, onChanged])

  const test = useCallback(async () => {
    if (!draft.id) return
    setBusy(true)
    setError(null)
    setProbe(null)
    try {
      const report = (await unwrap(api()?.connections.test(draft.id))) as {
        sftp?: boolean
        rsync?: boolean
        rsyncVersion?: string | null
      }
      setProbe(
        `SSH ok · SFTP ${report.sftp ? 'ok' : 'unavailable'} · rsync ${
          report.rsync ? (report.rsyncVersion ?? 'ok') : 'not found'
        }`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [draft.id])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const canSave = draft.name.trim() !== '' && draft.host.trim() !== '' && draft.username.trim() !== '' && !busy

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(980px,94vw)] max-w-none flex-col gap-0 p-0">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <Server className="size-4 text-muted-foreground" />
          <div>
            <h2 className="text-[13px] font-medium">Servers</h2>
            <p className="text-[11px] text-muted-foreground">
              Used by both the transfer panes and Fleet.
            </p>
          </div>
        </header>

        {error ? (
          <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-surface px-4 py-2 text-[12px] text-danger-ink">
            <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
            <span className="selectable">{error}</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {/* --- the list ------------------------------------------------ */}
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-line">
            <div className="shrink-0 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter"
                  className="h-7 pl-7 text-[12px]"
                />
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-1.5 pb-2">
                {visibleSaved.map((connection) => (
                  <Row
                    key={connection.id}
                    connection={connection}
                    active={draft.id === connection.id}
                    onClick={() => select(connection, false)}
                  />
                ))}

                {visibleConfig.length > 0 ? (
                  <p className="px-2 pb-1 pt-3 text-[10.5px] uppercase tracking-wide text-faint">
                    From ~/.ssh/config
                  </p>
                ) : null}
                {visibleConfig.map((connection) => (
                  <Row
                    key={connection.id}
                    connection={connection}
                    active={draft.id === connection.id}
                    muted
                    onClick={() => select(connection, true)}
                  />
                ))}

                {visibleSaved.length === 0 && visibleConfig.length === 0 ? (
                  <p className="px-2 py-4 text-[12px] text-muted-foreground">
                    {filter ? 'Nothing matches that.' : 'No servers yet.'}
                  </p>
                ) : null}
              </div>
            </ScrollArea>

            <div className="flex shrink-0 gap-1 border-t border-line p-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(BLANK)
                  setReadOnly(false)
                  setProbe(null)
                }}
                className="flex-1 gap-1 text-[11.5px]"
              >
                <Plus className="size-3.5" />
                New
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Copy this server's settings into a new one"
                disabled={!draft.host}
                onClick={() => {
                  setDraft((current) => ({ ...current, id: null, name: `${current.name}-copy` }))
                  setReadOnly(false)
                  setProbe(null)
                }}
                className="gap-1 text-[11.5px]"
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Import every host from ~/.ssh/config"
                onClick={() =>
                  void (async () => {
                    setBusy(true)
                    try {
                      await unwrap(api()?.connections.importSshConfig())
                      await refresh()
                      onChanged()
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : String(caught))
                    } finally {
                      setBusy(false)
                    }
                  })()
                }
                className="gap-1 text-[11.5px]"
              >
                <FileDown className="size-3.5" />
              </Button>
            </div>
          </aside>

          {/* --- the form ------------------------------------------------ */}
          <section className="flex min-w-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 p-4">
                {readOnly ? (
                  <p className="rounded-md border border-line bg-secondary px-2.5 py-2 text-[11.5px] text-muted-foreground">
                    This one comes from <code>~/.ssh/config</code> and is not edited here. Save a copy to make it
                    yours — the file stays untouched.
                  </p>
                ) : null}

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name">
                    <Input value={draft.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Tags" hint="Comma separated. Fleet selects on these: --on tag:production">
                    <Input value={draft.tags} onChange={(e) => set('tags', e.target.value)} disabled={readOnly} placeholder="production, web" className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Host">
                    <Input value={draft.host} onChange={(e) => set('host', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Port">
                    <Input type="number" value={draft.port} onChange={(e) => set('port', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Username">
                    <Input value={draft.username} onChange={(e) => set('username', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Authentication">
                    <select
                      value={draft.authType}
                      onChange={(e) => set('authType', e.target.value as 'agent' | 'key')}
                      disabled={readOnly}
                      className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-[12.5px]"
                    >
                      <option value="agent">SSH agent</option>
                      <option value="key">Key file</option>
                    </select>
                  </Field>
                  {draft.authType === 'key' ? (
                    <Field label="Key file" className="col-span-2">
                      <Input value={draft.keyPath} onChange={(e) => set('keyPath', e.target.value)} disabled={readOnly} placeholder="~/.ssh/id_ed25519" className="h-8 text-[12.5px]" />
                    </Field>
                  ) : null}
                  <Field label="Default remote path" className="col-span-2">
                    <Input value={draft.defaultRemotePath} onChange={(e) => set('defaultRemotePath', e.target.value)} disabled={readOnly} placeholder="/srv/app" className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Jump host" hint="ProxyJump, e.g. bastion or user@bastion:2222">
                    <Input value={draft.jumpHost} onChange={(e) => set('jumpHost', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Remote rsync path" hint="Only if rsync is somewhere unusual">
                    <Input value={draft.rsyncPath} onChange={(e) => set('rsyncPath', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                  <Field label="Notes" className="col-span-2">
                    <Input value={draft.notes} onChange={(e) => set('notes', e.target.value)} disabled={readOnly} className="h-8 text-[12.5px]" />
                  </Field>
                </div>

                <label className="group/field flex items-center gap-2 pt-1 text-[12px]">
                  <Checkbox
                    checked={draft.forwardAgent}
                    onCheckedChange={() => set('forwardAgent', !draft.forwardAgent)}
                    disabled={readOnly}
                  />
                  <span>
                    Forward the SSH agent
                    <span className="ml-1.5 text-faint">
                      — anyone with root on this host can then authenticate as you, anywhere your keys are accepted
                    </span>
                  </span>
                </label>

                {probe ? (
                  <p className="flex items-center gap-1.5 rounded-md border border-line bg-secondary px-2.5 py-1.5 text-[11.5px] text-ok">
                    <ShieldCheck className="size-3.5" />
                    {probe}
                  </p>
                ) : null}
              </div>
            </ScrollArea>

            <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-chrome px-4 py-2.5">
              <Button onClick={() => void save()} disabled={!canSave} className="text-[12px]">
                {readOnly ? 'Save a copy' : draft.id ? 'Save changes' : 'Create server'}
              </Button>
              <Button variant="outline" onClick={() => void test()} disabled={!draft.id || readOnly || busy} className="text-[12px]">
                Test
              </Button>
              {draft.id && !readOnly ? (
                <Button variant="destructive" onClick={() => void remove()} disabled={busy} className="ml-auto gap-1.5 text-[12px]">
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              ) : null}
            </footer>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row({
  connection,
  active,
  muted,
  onClick,
}: {
  connection: Connection
  active: boolean
  muted?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-ring flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? 'bg-secondary' : 'hover:bg-secondary/60'
      }`}
    >
      <span className={`w-full truncate text-[12.5px] ${muted ? 'text-muted-foreground' : ''}`}>{connection.name}</span>
      <span className="w-full truncate text-[10.5px] text-faint">
        {connection.username}@{connection.host}
        {connection.port !== 22 ? `:${connection.port}` : ''}
      </span>
      {(connection.tags ?? []).length > 0 ? (
        <span className="mt-0.5 flex flex-wrap gap-1">
          {(connection.tags ?? []).slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="px-1 py-0 text-[9.5px]">
              {tag}
            </Badge>
          ))}
        </span>
      ) : null}
    </button>
  )
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-[11px] text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="mt-0.5 text-[10.5px] text-faint">{hint}</p> : null}
    </div>
  )
}
