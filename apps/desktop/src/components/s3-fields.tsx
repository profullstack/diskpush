'use client'

import { Database, KeyRound, Server } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  applyPreset,
  endpointHint,
  fieldIssue,
  S3_PRESETS,
  type PathStyleChoice,
  type S3Draft,
  type S3Provider,
} from '@/lib/s3-form'

/** A native select dressed like the Input beside it: same ground in both themes. */
export const SELECT_CLASS =
  'focus-ring h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'
const SELECT = SELECT_CLASS

/**
 * The S3 bucket fields, shared by both connection forms.
 *
 * The secret access key is a password input that starts empty every time: the
 * stored key never comes back from the main process. When one is stored the
 * field says so, and leaving it blank keeps it.
 */
export function S3Fields({
  value,
  onChange,
  disabled,
  labelClassName,
}: {
  value: S3Draft
  onChange: (next: S3Draft) => void
  disabled?: boolean
  labelClassName?: string
}) {
  const preset = S3_PRESETS[value.provider]
  const set = <K extends keyof S3Draft>(key: K, next: S3Draft[K]) => onChange({ ...value, [key]: next })
  // Shown at the field it is about, so a disabled Save always has its reason in view.
  const bucketIssue = fieldIssue(value, 'bucket')
  const endpointIssue = fieldIssue(value, 'endpoint')
  const regionIssue = fieldIssue(value, 'region')

  return (
    <div className="grid grid-cols-2 gap-3">
      <Item label="Provider" labelClassName={labelClassName}>
        <select
          value={value.provider}
          onChange={(event) => onChange(applyPreset(value, event.target.value as S3Provider))}
          disabled={disabled}
          className={SELECT}
        >
          {(Object.keys(S3_PRESETS) as S3Provider[]).map((id) => (
            <option key={id} value={id}>
              {S3_PRESETS[id].label}
            </option>
          ))}
        </select>
      </Item>
      <Item label="Bucket" error={bucketIssue} labelClassName={labelClassName}>
        <Input
          value={value.bucket}
          onChange={(event) => set('bucket', event.target.value)}
          disabled={disabled}
          placeholder="my-backups"
          aria-invalid={bucketIssue ? true : undefined}
          className="h-8 text-[12.5px]"
        />
      </Item>
      <Item label="Endpoint URL" hint={endpointHint(value)} error={endpointIssue} className="col-span-2" labelClassName={labelClassName}>
        <Input
          value={value.endpoint}
          onChange={(event) => set('endpoint', event.target.value)}
          disabled={disabled}
          placeholder={value.provider === 'aws' ? 'AWS (from the region)' : 'https://…'}
          aria-invalid={endpointIssue ? true : undefined}
          className="h-8 font-[family-name:var(--font-mono)] text-[12px]"
        />
      </Item>
      <Item label="Region" error={regionIssue} labelClassName={labelClassName}>
        <Input
          value={value.region}
          onChange={(event) => set('region', event.target.value)}
          disabled={disabled}
          placeholder="us-east-1"
          aria-invalid={regionIssue ? true : undefined}
          className="h-8 text-[12.5px]"
        />
      </Item>
      <Item label="Addressing" labelClassName={labelClassName}>
        <select
          value={value.pathStyle}
          onChange={(event) => set('pathStyle', event.target.value as PathStyleChoice)}
          disabled={disabled}
          className={SELECT}
        >
          <option value="auto">Auto</option>
          <option value="on">Path-style (endpoint/bucket)</option>
          <option value="off">Virtual-hosted (bucket.endpoint)</option>
        </select>
      </Item>
      {/* One hint row under both, so a long hint cannot push one column out of line with the other. */}
      <p className="col-span-2 -mt-2 text-[10.5px] text-faint">
        {preset.regionHint} Addressing on Auto uses path-style for a custom endpoint, virtual-hosted for AWS.
      </p>
      <Item label="Access key ID" hint="Empty reads AWS_ACCESS_KEY_ID." labelClassName={labelClassName}>
        <Input
          value={value.accessKeyId}
          onChange={(event) => set('accessKeyId', event.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          className="h-8 font-[family-name:var(--font-mono)] text-[12px]"
        />
      </Item>
      <Item
        label="Secret access key"
        hint={
          value.clearSecret
            ? 'The stored key will be removed on save.'
            : value.hasSecret
              ? 'Saved. Leave empty to keep it, or type a new one to replace it.'
              : 'Stored on this machine only, never shown again. Empty reads AWS_SECRET_ACCESS_KEY.'
        }
        labelClassName={labelClassName}
      >
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            value={value.secret}
            onChange={(event) => onChange({ ...value, secret: event.target.value, clearSecret: false })}
            disabled={disabled || value.clearSecret}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={value.hasSecret && !value.clearSecret ? '•••••••• saved' : ''}
            className="h-8 text-[12.5px]"
          />
          {value.hasSecret ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, secret: '', clearSecret: !value.clearSecret })}
              className="focus-ring h-8 shrink-0 rounded-md border border-input px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
              title={value.clearSecret ? 'Keep the stored key' : 'Remove the stored key'}
            >
              {value.clearSecret ? 'Keep' : 'Clear'}
            </button>
          ) : (
            <KeyRound className="size-3.5 shrink-0 text-faint" />
          )}
        </div>
      </Item>
    </div>
  )
}

const KINDS = [
  { id: 'ssh', label: 'SSH server', icon: Server },
  { id: 's3', label: 'S3 bucket', icon: Database },
] as const

/** SSH server | S3 bucket, as one segmented control: two values of one setting. */
export function KindSwitch({
  value,
  onChange,
  disabled,
}: {
  value: 'ssh' | 's3'
  onChange: (kind: 'ssh' | 's3') => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Connection kind" className="inline-flex self-start rounded-lg border border-line-strong bg-sunken p-0.5">
      {KINDS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={disabled}
          onClick={() => onChange(option.id)}
          className={cn(
            'focus-ring inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[12px] font-medium transition-colors',
            value === option.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <option.icon className="size-3.5" />
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Item({
  label,
  hint,
  error,
  className,
  labelClassName,
  children,
}: {
  label: string
  hint?: string
  /** Replaces the hint while set: what is wrong with this field. */
  error?: string | null
  className?: string
  labelClassName?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <Label className={cn('mb-1 block text-[11px] text-muted-foreground', labelClassName)}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="mt-0.5 text-[10.5px] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-0.5 text-[10.5px] text-faint">{hint}</p>
      ) : null}
    </div>
  )
}
