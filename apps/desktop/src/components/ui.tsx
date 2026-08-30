'use client'

import type { ReactNode } from 'react'
import { Icon } from './icons'

/**
 * The primitives, in the shape shadcn/ui uses. Kept local rather than
 * generated: the desktop bundle should stay small, and the palette is the
 * one in globals.css.
 */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'quiet'

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'border border-line-strong bg-raised text-text hover:border-[#2c3b56] hover:bg-[#182334]',
  primary:
    'border-0 bg-gradient-to-b from-[#1a6dfd] to-[#0b52e0] text-white font-medium shadow-[0_4px_14px_-4px_#0b62fd99] hover:brightness-110',
  danger: 'border border-[#4a2230] bg-transparent text-danger hover:bg-[#f871711a]',
  ghost: 'border border-transparent bg-transparent text-muted hover:bg-raised hover:text-text',
  quiet: 'border border-line-strong bg-transparent text-muted hover:text-text hover:border-[#2c3b56]',
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg px-3 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

/** A square icon-only button, for path bars and dialog corners. */
export function IconButton({
  children,
  onClick,
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-transparent text-muted transition-colors hover:bg-raised hover:text-text ${className}`}
    >
      {children}
    </button>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface ${className}`}>
      {children}
    </div>
  )
}

/** A small uppercase label: SOURCE, DESTINATION, column heads, field names. */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-[10px] uppercase tracking-[0.09em] text-faint ${className}`}>{children}</span>
  )
}

export function Dialog({
  open,
  title,
  subtitle,
  icon,
  tone = 'neutral',
  children,
  onClose,
  footer,
  wide,
}: {
  open: boolean
  title: string
  subtitle?: string
  icon?: ReactNode
  tone?: 'neutral' | 'danger'
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
}) {
  if (!open) return null
  const badge = tone === 'danger' ? 'bg-[#2a1620] text-danger' : 'bg-[#12244a] text-accent'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-[0_24px_60px_-20px_#000000cc] ${wide ? 'max-w-3xl' : 'max-w-xl'}`}
      >
        <div className="flex items-center gap-3 border-b border-line px-[18px] py-4">
          {icon ? <span className={`flex h-[30px] w-[30px] items-center justify-center rounded-lg ${badge}`}>{icon}</span> : null}
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">{title}</div>
            {subtitle ? (
              <div className="selectable mt-0.5 truncate font-[family-name:var(--font-mono)] text-[11.5px] text-muted">
                {subtitle}
              </div>
            ) : null}
          </div>
          <IconButton onClick={onClose} title="Close" className="ml-auto border-line-strong">
            <Icon.close size={14} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-[18px] py-4">{children}</div>

        {footer ? <div className="flex items-center gap-2 border-t border-line px-[18px] py-3.5">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1">
      <span
        className={`mt-[1px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded border transition-colors ${
          checked ? 'border-accent-strong bg-accent-strong text-white' : 'border-[#2c3b56] bg-ink'
        }`}
        onClick={() => onChange(!checked)}
      >
        {checked ? <Icon.check size={11} strokeWidth={3} /> : null}
      </span>
      <span onClick={() => onChange(!checked)}>
        <span className="text-[12.5px]">{label}</span>
        {hint ? <span className="mt-0.5 block text-[11px] leading-snug text-muted">{hint}</span> : null}
      </span>
    </label>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return (
    <input
      {...rest}
      className={`selectable h-[34px] w-full rounded-lg border border-line bg-ink px-[11px] font-[family-name:var(--font-mono)] text-[12.5px] outline-none transition-colors placeholder:text-faint focus:border-accent ${className}`}
    />
  )
}

export function Banner({ kind, children }: { kind: 'warn' | 'danger' | 'info' | 'ok'; children: ReactNode }) {
  const styles = {
    warn: 'border-warn/35 bg-warn/10 text-warn',
    danger: 'border-[#45202e] bg-[#1c1119] text-[#fca5a5]',
    info: 'border-line bg-sunken text-muted',
    ok: 'border-ok/30 bg-ok/10 text-ok',
  }[kind]
  return <div className={`selectable rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed ${styles}`}>{children}</div>
}
