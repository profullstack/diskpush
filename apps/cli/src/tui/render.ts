/**
 * Terminal drawing primitives.
 *
 * Hand-rolled rather than a TUI framework: the CLI bundle ships inside the
 * desktop app, and a full-screen browser is not worth another dependency tree
 * when what it needs is a box, a list and a status bar.
 */

// Built rather than written literally: a raw escape byte in a source file is
// invisible in diffs and review, and easy to mangle.
const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`

export const ansi = {
  clear: `${CSI}2J${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  altScreen: `${CSI}?1049h`,
  mainScreen: `${CSI}?1049l`,
  reset: `${CSI}0m`,
  dim: `${CSI}2m`,
  bold: `${CSI}1m`,
  reverse: `${CSI}7m`,
  blue: `${CSI}38;5;39m`,
  red: `${CSI}38;5;203m`,
  green: `${CSI}38;5;78m`,
  yellow: `${CSI}38;5;221m`,
  moveTo: (row: number, column: number) => `${CSI}${row};${column}H`,
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')

/** Visible width, ignoring escape sequences, which occupy no columns. */
export function width(text: string): number {
  return text.replace(ANSI_PATTERN, '').length
}

export function truncate(text: string, to: number): string {
  if (width(text) <= to) return text
  // Keeps the end of a path, which is the part that identifies it.
  const plain = text.replace(ANSI_PATTERN, '')
  if (to <= 1) return plain.slice(0, Math.max(0, to))
  return `…${plain.slice(-(to - 1))}`
}

export function pad(text: string, to: number): string {
  const visible = width(text)
  return visible >= to ? truncate(text, to) : text + ' '.repeat(to - visible)
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`
  const units = ['K', 'M', 'G', 'T', 'P']
  let value = bytes
  let unit = -1
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[unit]}`
}
