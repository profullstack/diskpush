'use client'

import { useState } from 'react'
import { Server, ShieldCheck } from 'lucide-react'
import { api, unwrap, type Connection } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const AUTH = [
  { id: 'agent', label: 'SSH agent' },
  { id: 'key', label: 'Key file' },
] as const

export function ConnectionDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: (connection: Connection) => void
}) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [port, setPort] = useState('22')
  const [remotePath, setRemotePath] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [auth, setAuth] = useState<'agent' | 'key'>('agent')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const connection = await unwrap(
        api()?.connections.save({
          name: name.trim(),
          host: host.trim(),
          username: username.trim(),
          port: Number(port) || 22,
          authType: auth,
          keyPath: auth === 'key' ? keyPath.trim() || null : null,
          defaultRemotePath: remotePath.trim() || null,
        }),
      )
      onSaved(connection)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  async function importSshConfig() {
    setBusy(true)
    setError(null)
    try {
      const imported = await unwrap(api()?.connections.importSshConfig())
      if (imported.length === 0) setError('No importable hosts found in ~/.ssh/config.')
      else {
        onSaved({} as Connection)
        onClose()
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-lg gap-0 border-line-strong bg-popover p-0 [--dialog-pad:0px]">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-line px-[18px] py-4">
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-info-surface text-primary">
            <Server className="size-[17px]" />
          </span>
          <DialogTitle className="text-[14px]">New server</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3.5 px-[18px] py-4">
          {error ? (
            <p className="selectable rounded-lg border border-danger-line bg-danger-surface px-3 py-2 text-[12px] text-danger-ink">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="production" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Host</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Port</Label>
              <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Username</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" />
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Authentication</Label>
            {/* A segmented control rather than two loose buttons: these are two
                values of one setting, and spacing them apart made them read as
                two independent actions. */}
            <div
              role="radiogroup"
              className="inline-flex self-start rounded-lg border border-line-strong bg-sunken p-0.5"
            >
              {AUTH.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={auth === option.id}
                  onClick={() => setAuth(option.id)}
                  className={cn(
                    'focus-ring h-[28px] rounded-[7px] px-3 text-[12px] font-medium transition-colors',
                    auth === option.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {auth === 'key' ? (
              <Input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" />
                <span>The agent holds the key, so DiskPush stores no secret. Nothing is written to disk.</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Default remote path</Label>
            <Input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/srv/app" />
          </div>
        </div>

        <DialogFooter className="items-center border-t border-line px-[18px] py-3.5 sm:justify-between">
          <Button variant="ghost" onClick={importSshConfig} disabled={busy} className="h-[33px] text-muted-foreground">
            Import from ~/.ssh/config
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="h-[33px] border-line-strong">
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={busy || !name.trim() || !host.trim() || !username.trim()}
              className="h-[33px] font-semibold"
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
