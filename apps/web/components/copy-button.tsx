'use client'

import { useEffect, useState } from 'react'

type State = 'idle' | 'copied' | 'failed'

/**
 * Copy-to-clipboard for a code block.
 *
 * Rendered only after mount. With JavaScript disabled the button never
 * appears, which is the honest outcome: a visible button that silently does
 * nothing is worse than no button, and the code stays selectable either way.
 */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [mounted, setMounted] = useState(false)
  const [state, setState] = useState<State>('idle')

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(timer)
  }, [state])

  if (!mounted) return null

  async function copy() {
    try {
      // Only available in a secure context; the catch covers http and denied
      // permissions rather than leaving the click with no feedback.
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === 'copied' ? 'Copied' : `${label} to clipboard`}
      className="rounded-md border border-line bg-raised px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press ⌘C' : label}
    </button>
  )
}
