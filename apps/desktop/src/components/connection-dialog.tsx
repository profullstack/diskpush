'use client'

import { useState } from 'react'
import { api, unwrap, type Connection } from '@/lib/api'
import { Banner, Button, Dialog, Field, Input } from './ui'

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
  const [remotePath, setRemotePath] = useState('/')
  const [keyPath, setKeyPath] = useState('')
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
          // Agent auth by default: it is the option that stores no secret
          // anywhere, which is why DiskPush prefers it.
          authType: keyPath.trim() ? 'key' : 'agent',
          keyPath: keyPath.trim() || null,
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
      else onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title="New server"
      onClose={onClose}
      footer={
        <>
          <Button onClick={importSshConfig} disabled={busy}>
            Import from ~/.ssh/config
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !name.trim() || !host.trim() || !username.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-1">
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="production" />
        </Field>
        <Field label="Host">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" />
        </Field>
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Username">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" />
            </Field>
          </div>
          <div className="w-24">
            <Field label="Port">
              <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
        </div>
        <Field label="Default remote path">
          <Input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/srv/app" />
        </Field>
        <Field label="Private key (leave empty to use the SSH agent)">
          <Input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
        </Field>
        <p className="pt-2 text-[11px] leading-relaxed text-muted">
          DiskPush stores no passwords or passphrases. The first connection to a host shows its
          fingerprint and asks once; if that key later changes, the connection is blocked rather
          than re-prompted.
        </p>
      </div>
    </Dialog>
  )
}
