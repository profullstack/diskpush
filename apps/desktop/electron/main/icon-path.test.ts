import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveIconPath, WM_CLASS } from './icon-path.js'

const PACKAGED = '/opt/DiskPush/resources/icon.png'
const CHECKOUT = '/home/you/diskpush/apps/desktop/resources/icon.png'

describe('resolveIconPath', () => {
  it('prefers the packaged copy when it is there', () => {
    expect(resolveIconPath([PACKAGED, CHECKOUT], () => true)).toBe(PACKAGED)
  })

  it('falls back to the checkout, which is the only copy in a dev run', () => {
    expect(resolveIconPath([PACKAGED, CHECKOUT], (path) => path === CHECKOUT)).toBe(CHECKOUT)
  })

  it('returns undefined rather than a path to nothing', () => {
    // BrowserWindow given a missing icon path logs nothing and shows no icon,
    // so a guess is indistinguishable from the bug this is fixing.
    expect(resolveIconPath([PACKAGED, CHECKOUT], () => false)).toBeUndefined()
  })
})

describe('StartupWMClass', () => {
  /**
   * A taskbar matches a window to its launcher by comparing the window's
   * WM_CLASS with the .desktop file's StartupWMClass. The app pins WM_CLASS to
   * WM_CLASS above; these two files are the other half of that agreement, and
   * a rename that touched only one of them would silently un-group the window
   * again — the exact symptom, with nothing failing.
   */
  const root = join(import.meta.dirname, '..', '..', '..', '..')

  it('is what the installer writes into its desktop entry', () => {
    const installer = readFileSync(join(root, 'scripts', 'install.sh'), 'utf8')
    expect(installer).toContain(`StartupWMClass=${WM_CLASS}`)
  })

  it('is what electron-builder writes into the packaged entry', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'))
    expect(manifest.build.linux.desktop.entry.StartupWMClass).toBe(WM_CLASS)
  })

  it('sits under desktop.entry as flat strings, the shape electron-builder 26 reads', () => {
    // electron-builder 26 rejects a flat `linux.desktop` map at schema
    // validation; 25 instead stringified the nested object, so the deb shipped
    // `entry=[object Object]` and lost its Keywords without a warning. The
    // builder version and this shape have to move together.
    const manifest = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'))
    expect(Object.keys(manifest.build.linux.desktop)).toEqual(['entry'])
    for (const value of Object.values(manifest.build.linux.desktop.entry)) {
      expect(typeof value).toBe('string')
    }
  })
})

describe('Linux icon set', () => {
  /**
   * An icon theme is searched only in the directories its index.theme lists.
   * Given one PNG, electron-builder files it under its pixel size, and the
   * 1254px source landed in hicolor/1254x1254/, which no desktop looks in, so
   * Plasma drew a generic icon. The set has to be standard sizes, each file
   * really that size.
   */
  const root = join(import.meta.dirname, '..', '..', '..', '..')
  const desktop = join(root, 'apps', 'desktop')
  const HICOLOR = [16, 22, 24, 32, 48, 64, 96, 128, 192, 256, 512]

  it('is the directory both electron-builder and the tarball use', () => {
    const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'))
    expect(manifest.build.linux.icon).toBe('resources/icons')
    expect(manifest.build.extraResources).toContainEqual({ from: 'resources/icons', to: 'icons' })
  })

  it('holds only hicolor sizes, each file the size its name says', () => {
    const files = readdirSync(join(desktop, 'resources', 'icons'))
    expect(files).toContain('512x512.png')
    for (const file of files) {
      const match = /^(\d+)x(\d+)\.png$/.exec(file)
      expect(match, file).not.toBeNull()
      const size = Number(match![1])
      expect(HICOLOR, file).toContain(size)
      // A PNG's IHDR puts width and height at bytes 16 and 20.
      const png = readFileSync(join(desktop, 'resources', 'icons', file))
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], file).toEqual([size, size])
    }
  })
})
