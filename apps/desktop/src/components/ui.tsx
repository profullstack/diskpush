'use client'

import type { ReactNode } from 'react'

/**
 * The small set of primitives this app needs, in the shape shadcn/ui uses.
 * Kept local rather than generated so the desktop bundle stays small and the
 * dark-first palette is the one in globals.css.
 */

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
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  title?: string
  className?: string
}) {
  const styles = {
    default: 'border border-line bg-raised hover:bg-surface',
    primary: 'bg-accent-strong text-white font-medium hover:opacity-90',
    danger: 'border border-danger/50 text-danger hover:bg-danger/10',
    ghost: 'text-muted hover:bg-surface hover:text-text',
  }[variant]

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2.5 py-1.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-0 min-w-0 flex-col border border-line bg-surface ${className}`}>{children}</div>
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div
        className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-line bg-raised shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-medium">{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div> : null}
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
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span>
        <span>{label}</span>
        {hint ? <span className="block text-[11px] text-muted">{hint}</span> : null}
      </span>
    </label>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block py-1.5">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full select-text rounded-md border border-line bg-ink px-2.5 py-1.5 outline-none focus:border-accent ${props.className ?? ''}`}
    />
  )
}

export function Banner({ kind, children }: { kind: 'warn' | 'danger' | 'info'; children: ReactNode }) {
  const styles = {
    warn: 'border-warn/40 bg-warn/10 text-warn',
    danger: 'border-danger/40 bg-danger/10 text-danger',
    info: 'border-line bg-surface text-muted',
  }[kind]
  return <div className={`select-text rounded-md border px-3 py-2 text-[12px] ${styles}`}>{children}</div>
}
