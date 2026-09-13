import { describe, expect, it } from 'vitest'
import { KITTY_IMAGE_ID, chooseProtocol, deleteImage, encodeImage, fitCells, fitsNaturally, placeAt, tmuxPassthrough } from './graphics.js'
import { blankDocument, fillDocument, imageInfo, isImageName } from './model.js'

/** A 1×1 transparent PNG. */
export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

describe('choosing a protocol', () => {
  it('speaks kitty to kitty and ghostty, and iTerm2 to everyone else, tmux included', () => {
    expect(chooseProtocol('kitty')).toBe('kitty')
    expect(chooseProtocol('ghostty')).toBe('kitty')
    expect(chooseProtocol('wezterm')).toBe('iterm2')
    expect(chooseProtocol('iterm')).toBe('iterm2')
    expect(chooseProtocol('tmux')).toBe('iterm2')
    expect(chooseProtocol('unknown')).toBe('iterm2')
  })
})

describe('fitting an image to a box', () => {
  it('keeps the shape, counting a cell as twice as tall as wide', () => {
    // A 200×100 image is 200 columns by 50 rows in cell units: twice the box's width matters.
    expect(fitCells({ width: 200, height: 100 }, { cols: 100, rows: 50 })).toEqual({ cols: 100, rows: 25 })
    expect(fitCells({ width: 100, height: 400 }, { cols: 100, rows: 50 })).toEqual({ cols: 25, rows: 50 })
    expect(fitCells({ width: 0, height: 0 }, { cols: 100, rows: 50 })).toEqual({ cols: 0, rows: 0 })
  })

  it('draws an icon at its own size and shrinks a photo', () => {
    expect(fitsNaturally({ width: 64, height: 64 }, { cols: 80, rows: 20 })).toBe(true)
    expect(fitsNaturally({ width: 4000, height: 3000 }, { cols: 80, rows: 20 })).toBe(false)
  })
})

describe('encoding', () => {
  const info = imageInfo(PNG_1x1)!

  const photo = { ...info, width: 4000, height: 3000 }

  it('iTerm2: one OSC 1337 carrying the file, sized to the box, aspect kept', () => {
    const seq = encodeImage('iterm2', PNG_1x1, photo, { cols: 80, rows: 20 })!
    expect(seq.startsWith(`\x1b]1337;File=inline=1;size=${PNG_1x1.length};width=80;height=20;preserveAspectRatio=1:`)).toBe(true)
    expect(encodeImage('iterm2', PNG_1x1, info, { cols: 80, rows: 20 })).toContain(';width=auto;height=auto;')
    expect(seq.endsWith('\x07')).toBe(true)
    const payload = seq.slice(seq.indexOf(':') + 1, -1)
    expect(Buffer.from(payload, 'base64').equals(PNG_1x1)).toBe(true)
  })

  it('kitty: chunked APC with the id, the fitted cell box, and PNG only', () => {
    const seq = encodeImage('kitty', PNG_1x1, photo, { cols: 80, rows: 20 })!
    expect(seq.startsWith(`\x1b_Ga=T,f=100,i=${KITTY_IMAGE_ID},c=53,r=20,q=2,m=0;`)).toBe(true)
    expect(encodeImage('kitty', PNG_1x1, info, { cols: 80, rows: 20 })).toContain(`i=${KITTY_IMAGE_ID},q=2,m=0;`)
    expect(seq.endsWith('\x1b\\')).toBe(true)
    expect(encodeImage('kitty', PNG_1x1, { ...info, format: 'jpeg' }, { cols: 80, rows: 20 })).toBeNull()
    // A big payload is cut into 4096-character chunks, m=1 on all but the last.
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(9000)])
    const chunked = encodeImage('kitty', big, photo, { cols: 80, rows: 20 })!
    const parts = chunked.split('\x1b\\').filter(Boolean)
    expect(parts.length).toBe(3)
    expect(parts[0]).toContain(',m=1;')
    expect(parts[1]!.startsWith('\x1b_Gm=1;')).toBe(true)
    expect(parts[2]!.startsWith('\x1b_Gm=0;')).toBe(true)
    expect(Buffer.from(parts.map((part) => part.slice(part.indexOf(';') + 1)).join(''), 'base64').equals(big)).toBe(true)
  })

  it('deletes by id under kitty, and has nothing to delete under iTerm2', () => {
    expect(deleteImage('kitty')).toBe(`\x1b_Ga=d,d=I,i=${KITTY_IMAGE_ID},q=2\x1b\\`)
    expect(deleteImage('iterm2')).toBe('')
  })
})

describe('getting it through tmux and onto a cell', () => {
  it('wraps in a DCS envelope with every ESC doubled', () => {
    expect(tmuxPassthrough('\x1b]1337;x\x07')).toBe('\x1bPtmux;\x1b\x1b]1337;x\x07\x1b\\')
  })

  it('moves to the cell, draws, and puts the cursor back, wrapping only the image', () => {
    expect(placeAt('IMG', 4, 9, false)).toBe('\x1b7\x1b[10;5HIMG\x1b8')
    expect(placeAt('\x1bX', 0, 0, true)).toBe('\x1b7\x1b[1;1H\x1bPtmux;\x1b\x1bX\x1b\\\x1b8')
  })
})

describe('reading image headers', () => {
  it('knows PNG, GIF, BMP, WebP and JPEG by their headers, and nothing else', () => {
    expect(imageInfo(PNG_1x1)).toEqual({ format: 'png', width: 1, height: 1 })
    expect(imageInfo(Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1'))).toEqual({ format: 'gif', width: 320, height: 240 })
    const bmp = Buffer.alloc(26)
    bmp.write('BM', 0, 'latin1')
    bmp.writeInt32LE(640, 18)
    bmp.writeInt32LE(-480, 22)
    expect(imageInfo(bmp)).toEqual({ format: 'bmp', width: 640, height: 480 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBP', 8, 'latin1')
    webp.write('VP8X', 12, 'latin1')
    webp.writeUIntLE(1023, 24, 3)
    webp.writeUIntLE(767, 27, 3)
    expect(imageInfo(webp)).toEqual({ format: 'webp', width: 1024, height: 768 })
    // SOI, an APP0 segment to step over, then SOF0 with height 600 and width 800.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03])
    expect(imageInfo(jpeg)).toEqual({ format: 'jpeg', width: 800, height: 600 })
    expect(imageInfo(Buffer.from('not an image at all, really'))).toBeNull()
    expect(imageInfo(new Uint8Array())).toBeNull()
  })
})

describe('an image as a document', () => {
  it('is an image when read whole, and a hex dump when the read was cut short', () => {
    const whole = blankDocument('left', 'dot.png', '/x/dot.png')
    fillDocument(whole, { bytes: PNG_1x1, size: PNG_1x1.length })
    expect(whole.kind).toBe('image')
    expect(whole.image).toEqual({ format: 'png', width: 1, height: 1 })
    const cut = blankDocument('left', 'huge.png', '/x/huge.png')
    fillDocument(cut, { bytes: PNG_1x1, size: 50_000_000 })
    expect(cut.kind).toBe('binary')
    expect(cut.image).toBeNull()
    expect(isImageName('a.JPG')).toBe(true)
    expect(isImageName('a.svg')).toBe(false)
  })
})
