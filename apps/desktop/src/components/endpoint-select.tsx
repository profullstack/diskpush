'use client'

import { Monitor, Plus, Server } from 'lucide-react'
import type { Connection } from '@/lib/api'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select'

export type PaneEndpoint = { kind: 'local' } | { kind: 'ssh'; connectionId: string }

const LOCAL = '__local__'
const ADD = '__add__'

/**
 * Where a pane points.
 *
 * Saved connections and `~/.ssh/config` hosts are listed separately on
 * purpose: they behave differently. A saved connection carries a port, a key,
 * a jump host and a default path; an ssh_config entry is whatever the file
 * says, offered so a machine that already has its servers written down needs
 * no re-entry.
 *
 * A custom host is added rather than typed inline. The renderer names a
 * connection by id and never a hostname, so that a compromised window cannot
 * pick somewhere to connect to; typing one goes through the connection form,
 * which is validated in the main process and saved.
 */
export function EndpointSelect({
  value,
  saved,
  sshConfig,
  onChange,
  onAddServer,
}: {
  value: PaneEndpoint
  saved: readonly Connection[]
  sshConfig: readonly Connection[]
  onChange: (endpoint: PaneEndpoint) => void
  onAddServer: () => void
}) {
  const current = value.kind === 'local' ? LOCAL : value.connectionId
  const selectedLabel =
    value.kind === 'local'
      ? 'This computer'
      : ([...saved, ...sshConfig].find((connection) => connection.id === value.connectionId)?.name ?? 'server')

  return (
    <Select
      value={current}
      onValueChange={(next) => {
        // Base UI hands back `null` when a select is cleared, so this cannot
        // assume a string and build a connection id out of it.
        const id = typeof next === 'string' ? next : null
        if (id === null) return
        if (id === ADD) {
          onAddServer()
          return
        }
        onChange(id === LOCAL ? { kind: 'local' } : { kind: 'ssh', connectionId: id })
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-[30px] max-w-[220px] gap-2 border-line-strong bg-secondary/60 text-[12px] font-medium"
      >
        {/*
          The label is rendered here rather than through SelectValue: Base UI
          resolves that from its registered items, and the grouped lists here
          left it showing the raw value ("__local__") instead of a name.
        */}
        <span className="flex min-w-0 items-center gap-2">
          {value.kind === 'local' ? (
            <Monitor className="size-[15px] shrink-0 text-muted-foreground" />
          ) : (
            <Server className="size-[15px] shrink-0 text-primary" />
          )}
          <span className="truncate">{selectedLabel}</span>
        </span>
      </SelectTrigger>

      <SelectContent className="border-line-strong bg-popover">
        <SelectItem value={LOCAL}>
          <Monitor className="text-muted-foreground" />
          This computer
        </SelectItem>

        {saved.length > 0 ? (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-faint">Saved</SelectLabel>
            {saved.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                <Server className="text-primary" />
                {connection.name}
                <span className="ml-1 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
                  {connection.username}@{connection.host}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}

        {sshConfig.length > 0 ? (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-faint">~/.ssh/config</SelectLabel>
            {sshConfig.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                <Server className="text-muted-foreground" />
                {connection.name}
                <span className="ml-1 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
                  {connection.username}@{connection.host}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}

        <SelectSeparator />
        <SelectItem value={ADD}>
          <Plus className="text-muted-foreground" />
          Add a server…
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
