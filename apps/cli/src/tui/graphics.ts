/**
 * Drawing an image in the terminal.
 *
 * Two protocols cover the terminals people use. The iTerm2 one (OSC 1337) is
 * one escape sequence carrying the file itself, in whatever format the
 * terminal can decode, and WezTerm, iTerm2 and Konsole speak it. The kitty one
 * (APC G) is spoken by kitty and Ghostty; it takes PNG only, and wants the
 * data in chunks. Both are ignored by a terminal that does not know them, so
 * guessing wrong costs a blank box rather than mojibake.
 *
 * tmux drops both unless told to pass them through, and then it wants each
 * sequence wrapped in a DCS envelope with every ESC doubled. `diskpush tui`
 * turns passthrough on for its own pane at startup; this file only wraps.
 *
 * Everything here is a pure function of bytes and numbers. The one effect,
 * writing to the terminal, is the caller's.
 */
import type { ImageInfo } from './model.js'

export type Protocol = 'iterm2' | 'kitty'

/**
 * Which protocol to speak, from hqtui's guess at the emulator.
 *
 * kitty and Ghostty do not speak iTerm2's; everything else that draws images
 * speaks it, and under tmux the emulator cannot be seen at all (tmux says
 * `tmux`), so iTerm2's is the default: WezTerm is what is usually out there.
 */
export function chooseProtocol(program: string): Protocol {
  return program === 'kitty' || program === 'ghostty' ? 'kitty' : 'iterm2'
}

/** The image id every placement uses, so the next one replaces the last and a delete finds it. */
export const KITTY_IMAGE_ID = 31337

/** Kitty wants its payload in chunks of at most this many base64 characters. */
const KITTY_CHUNK = 4096

/** A cell is about twice as tall as it is wide; that is all the fitting needs. */
const CELL_ASPECT = 2

/**
 * A guess at a cell in pixels, for one question only: does the image fit the
 * box at its own size? The terminal is not asked, because the answer would
 * arrive on stdin in the middle of hqtui's input stream. Guessing small keeps
 * a photo scaled down; guessing a little wrong only changes which icons are
 * drawn one-to-one and which are shrunk.
 */
const CELL_PX = { width: 10, height: 20 }

/** True when the image is small enough to be drawn at its own size inside the box. */
export function fitsNaturally(image: { width: number; height: number }, box: { cols: number; rows: number }): boolean {
  return image.width <= box.cols * CELL_PX.width && image.height <= box.rows * CELL_PX.height
}

/**
 * How many cells an image should take to fit a box without distortion.
 *
 * The iTerm2 protocol keeps the aspect ratio itself; kitty stretches to
 * whatever cell box it is given, so the box has to be the image's shape.
 */
export function fitCells(image: { width: number; height: number }, box: { cols: number; rows: number }): { cols: number; rows: number } {
  if (image.width <= 0 || image.height <= 0 || box.cols <= 0 || box.rows <= 0) return { cols: 0, rows: 0 }
  // The image in cell units: width in columns, height in rows.
  const wide = image.width
  const tall = image.height / CELL_ASPECT
  const scale = Math.min(box.cols / wide, box.rows / tall)
  return { cols: Math.max(1, Math.floor(wide * scale)), rows: Math.max(1, Math.floor(tall * scale)) }
}

/** An image as the terminal's escape sequence, sized to a box of cells. Null when the protocol cannot take the format. */
export function encodeImage(
  protocol: Protocol,
  bytes: Uint8Array,
  info: ImageInfo,
  box: { cols: number; rows: number },
): string | null {
  const data = Buffer.from(bytes).toString('base64')
  // A photo is shrunk to the box; an icon is drawn as it is, not blown up to fill it.
  const natural = fitsNaturally(info, box)
  if (protocol === 'iterm2') {
    const size = natural ? ['width=auto', 'height=auto'] : [`width=${box.cols}`, `height=${box.rows}`]
    const params = [`inline=1`, `size=${bytes.length}`, ...size, `preserveAspectRatio=1`]
    return `\x1b]1337;File=${params.join(';')}:${data}\x07`
  }
  if (info.format !== 'png') return null
  const fit = natural ? null : fitCells(info, box)
  const chunks: string[] = []
  for (let at = 0; at < data.length; at += KITTY_CHUNK) chunks.push(data.slice(at, at + KITTY_CHUNK))
  return chunks
    .map((chunk, index) => {
      const last = index === chunks.length - 1
      const control =
        index === 0
          ? `a=T,f=100,i=${KITTY_IMAGE_ID},${fit ? `c=${fit.cols},r=${fit.rows},` : ''}q=2,m=${last ? 0 : 1}`
          : `m=${last ? 0 : 1}`
      return `\x1b_G${control};${chunk}\x1b\\`
    })
    .join('')
}

/** Takes the last placement down. iTerm2 images are cells, and cells are cleared by drawing over them. */
export function deleteImage(protocol: Protocol): string {
  return protocol === 'kitty' ? `\x1b_Ga=d,d=I,i=${KITTY_IMAGE_ID},q=2\x1b\\` : ''
}

/** A sequence tmux will hand to the terminal untouched, given `allow-passthrough on`. */
export function tmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
}

/**
 * The bytes that put `sequence` at a cell and leave the cursor where it was.
 *
 * The cursor moves are outside any tmux envelope, because tmux has to see
 * them to know where the image lands; only the image itself is wrapped.
 */
export function placeAt(sequence: string, x: number, y: number, tmux: boolean): string {
  const body = tmux ? tmuxPassthrough(sequence) : sequence
  return `\x1b7\x1b[${y + 1};${x + 1}H${body}\x1b8`
}
