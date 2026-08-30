'use client'

import { useEffect } from 'react'

/**
 * Adds a copy button to every code block on a docs page.
 *
 * The docs are rendered Markdown, so their <pre> blocks are HTML rather than
 * React components and cannot take a prop. This enhances them after mount
 * instead: no JavaScript means no buttons and unchanged, readable docs.
 */
export function DocsCopyButtons() {
  useEffect(() => {
    const blocks = document.querySelectorAll<HTMLPreElement>('.prose-docs pre')
    const cleanups: Array<() => void> = []

    for (const block of blocks) {
      if (block.dataset.copyReady === 'true') continue
      block.dataset.copyReady = 'true'

      // The button is absolutely positioned against the block, so the block
      // has to establish a containing block for it.
      block.style.position = 'relative'

      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'Copy'
      button.setAttribute('aria-label', 'Copy code to clipboard')
      button.className =
        'absolute right-2 top-2 rounded-md border border-line bg-raised px-2 py-1 font-mono text-[10px] ' +
        'uppercase tracking-wider text-muted opacity-0 transition hover:border-accent hover:text-accent ' +
        'focus:opacity-100 group-hover:opacity-100'
      // Keeps it discoverable on touch, where there is no hover.
      button.style.opacity = '0.55'

      let timer: ReturnType<typeof setTimeout> | undefined
      const onClick = async () => {
        const code = block.querySelector('code')
        const text = (code ?? block).textContent ?? ''
        try {
          await navigator.clipboard.writeText(text.replace(/\n$/, ''))
          button.textContent = 'Copied'
        } catch {
          button.textContent = 'Press ⌘C'
        }
        clearTimeout(timer)
        timer = setTimeout(() => {
          button.textContent = 'Copy'
        }, 1600)
      }

      button.addEventListener('click', onClick)
      block.appendChild(button)

      cleanups.push(() => {
        clearTimeout(timer)
        button.removeEventListener('click', onClick)
        button.remove()
        delete block.dataset.copyReady
      })
    }

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  return null
}
