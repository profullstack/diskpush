/**
 * Key events for tests.
 *
 * The TUI is driven by HQTUI's parsed `KeyEvent`, so a test that wants to press
 * a key has to build one. Every field matters somewhere — `char` is what the
 * filter and the endpoint picker type with, and `key` is what Ctrl+C matches —
 * so they are derived here once rather than spelled out at each call site.
 */
import type { KeyEvent } from '@profullstack/hqtui'

export function key(name: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): KeyEvent {
  const ctrl = modifiers.ctrl ?? false
  const alt = modifiers.alt ?? false
  const shift = modifiers.shift ?? false
  const printable = name.length === 1
  const prefix = `${ctrl ? 'ctrl+' : ''}${alt ? 'alt+' : ''}${shift ? 'shift+' : ''}`
  return {
    type: 'key',
    name,
    ctrl,
    alt,
    shift,
    ...(printable && !ctrl && !alt ? { char: name } : {}),
    key: `${prefix}${name}`,
    raw: printable ? name : '',
  }
}
