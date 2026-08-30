/**
 * Turns raw terminal input into logical keys.
 *
 * A terminal sends an arrow key as three bytes: escape, `[`, then a letter.
 * Reading input a character at a time therefore sees a bare escape first — and
 * if escape means quit, every arrow key closes the program. That is the bug
 * this file exists to prevent, so the sequences are parsed as units and only a
 * escape arriving alone counts as one.
 */
const ESC = String.fromCharCode(27)

export type Key =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'tab'
  | 'escape'
  | 'page-up'
  | 'page-down'
  | 'home'
  | 'end'
  | { char: string }

const CSI_FINAL: Record<string, Key> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
}

const CSI_TILDE: Record<string, Key> = {
  '1': 'home',
  '4': 'end',
  '5': 'page-up',
  '6': 'page-down',
  '7': 'home',
  '8': 'end',
}

export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  let i = 0

  while (i < chunk.length) {
    const char = chunk[i]!

    if (char !== ESC) {
      if (char === '\r' || char === '\n') keys.push('enter')
      else if (char === '\t') keys.push('tab')
      else keys.push({ char })
      i += 1
      continue
    }

    // Escape with nothing after it in this chunk is the key itself.
    if (i + 1 >= chunk.length) {
      keys.push('escape')
      i += 1
      continue
    }

    // CSI: ESC [ ... final
    if (chunk[i + 1] === '[') {
      let j = i + 2
      let parameters = ''
      while (j < chunk.length && /[0-9;]/.test(chunk[j]!)) {
        parameters += chunk[j]
        j += 1
      }
      const final = chunk[j]
      if (final === undefined) {
        // Truncated sequence; drop it rather than emit a spurious escape.
        break
      }
      if (final === '~') {
        const key = CSI_TILDE[parameters]
        if (key) keys.push(key)
      } else {
        const key = CSI_FINAL[final]
        if (key) keys.push(key)
      }
      i = j + 1
      continue
    }

    // SS3: ESC O <final>, which some terminals send for arrows in application mode.
    if (chunk[i + 1] === 'O' && i + 2 < chunk.length) {
      const key = CSI_FINAL[chunk[i + 2]!]
      if (key) keys.push(key)
      i += 3
      continue
    }

    // Alt+key and anything else unrecognised: ignore rather than quit.
    i += 2
  }

  return keys
}

export function isChar(key: Key, char: string): boolean {
  return typeof key === 'object' && key.char === char
}
