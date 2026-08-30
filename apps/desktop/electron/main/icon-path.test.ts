import { readFileSync } from 'node:fs'
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
})
