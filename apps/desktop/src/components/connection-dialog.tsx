'use client'

import { useState } from 'react'
import { Database, Server, ShieldCheck } from 'lucide-react'
import { api, unwrap, type Connection } from '@/lib/api'
import { KindSwitch, S3Fields } from '@/components/s3-fields'
import { BLANK_S3, s3Payload, s3Problem, type S3Draft } from '@/lib/s3-form'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const AUTH = [
  { id: 'agent', label: 'SSH agent' },
  { id: 'key', label: 'Key file' },
] as const

const LABEL = 'text-[10.5px] uppercase tracking-[0.08em] text-faint'

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
  const [kind, setKind] = useState<'ssh' | 's3'>('ssh')
  const [s3, setS3] = useState<S3Draft>(BLANK_S3)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const s3Issue = s3Problem(s3)
  const canSave = name.trim() !== '' && (kind === 's3' ? s3Issue === null : host.trim() !== '' && username.trim() !== '')

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const connection = await unwrap(
        api()?.connections.save(
          kind === 's3'
            ? {
                // host, username and port are derived from the endpoint and
                // bucket in the main process.
                kind: 's3',
                name: name.trim(),
                ...s3Payload(s3),
                defaultRemotePath: remotePath.trim() || null,
              }
            : {
                kind: 'ssh',
                name: name.trim(),
                host: host.trim(),
                username: username.trim(),
                port: Number(port) || 22,
                authType: auth,
                keyPath: auth === 'key' ? keyPath.trim() || null : null,
                defaultRemotePath: remotePath.trim() || null,
              },
        ),
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
      {/*
        A column with only the body scrolling: the dialog is capped at the
        window height, and at 960x600 the S3 form is taller than that, which
        used to clip the footer and leave Save unreachable.
      */}
      <DialogContent className="flex max-w-lg flex-col gap-0 border-line-strong bg-popover p-0 [--dialog-pad:0px]">
        <DialogHeader className="shrink-0 flex-row items-center gap-3 space-y-0 border-b border-line px-[18px] py-4">
          <span className="flex size-[30px] items-center justify-center rounded-lg bg-info-surface text-primary">
            {kind === 's3' ? <Database className="size-[17px]" /> : <Server className="size-[17px]" />}
          </span>
          <DialogTitle className="text-[14px]">{kind === 's3' ? 'New S3 bucket' : 'New server'}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] py-4">
          {error ? (
            <p className="selectable rounded-lg border border-danger-line bg-danger-surface px-3 py-2 text-[12px] text-danger-ink">
              {error}
            </p>
          ) : null}

          <KindSwitch value={kind} onChange={setKind} disabled={busy} />

          <div className="flex flex-col gap-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 's3' ? 'backups' : 'production'} />
          </div>

          {kind === 's3' ? (
            <S3Fields value={s3} onChange={setS3} disabled={busy} labelClassName={LABEL} />
          ) : (
          <>
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
          </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.08em] text-faint">
              {kind === 's3' ? 'Default path in the bucket' : 'Default remote path'}
            </Label>
            <Input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder={kind === 's3' ? '/' : '/srv/app'} />
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-line px-[18px] py-3.5 sm:justify-between">
          {/* ~/.ssh/config holds servers, never buckets. The empty span keeps Save on the right. */}
          {kind === 'ssh' ? (
            <Button variant="ghost" onClick={importSshConfig} disabled={busy} className="h-[33px] text-muted-foreground">
              Import from ~/.ssh/config
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="h-[33px] border-line-strong">
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={busy || !canSave}
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
