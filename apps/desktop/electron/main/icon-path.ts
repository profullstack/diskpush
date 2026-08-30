/**
 * Where the window icon lives, which differs between a packaged app and a
 * checkout.
 *
 * Packaged, electron-builder copies resources/icon.png to `extraResources`, so
 * it sits beside the app under `process.resourcesPath`. Run from a checkout,
 * `process.resourcesPath` is Electron's own resources directory and holds
 * nothing of ours, so the repo copy is the fallback.
 *
 * Kept apart from index.ts, and given its own `exists`, so the ordering can be
 * tested without Electron and without touching a disk.
 */
export function resolveIconPath(
  candidates: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  // Undefined rather than a guess: BrowserWindow given a path to nothing logs
  // no error and shows no icon, which is indistinguishable from not asking.
  return candidates.find((candidate) => exists(candidate))
}

/**
 * The WM_CLASS the window reports, pinned rather than inherited.
 *
 * A Linux taskbar matches a window to its launcher by comparing WM_CLASS with
 * the .desktop file's StartupWMClass. Left alone, Chromium derives WM_CLASS
 * from the executable name, so it changes with `executableName` and differs
 * between the deb, the AppImage and a dev run — and a StartupWMClass written
 * to match one of those is wrong for the others. Naming it here means the
 * desktop entries can all state the same value.
 */
export const WM_CLASS = 'DiskPush'
