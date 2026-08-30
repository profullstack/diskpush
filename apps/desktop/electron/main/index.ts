import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, protocol, shell } from 'electron'
import { contentTypeFor, resolveBundlePath } from './bundle-path.js'
import { resolveIconPath, WM_CLASS } from './icon-path.js'
import { contentSecurityPolicy, inlineScriptHashes } from './csp.js'
import { registerIpc } from './ipc.js'
import { checkForUpdates } from './services/updater.js'
import { closeAllSessions } from './services/sessions.js'
import { cancelAllFleetRuns, hasActiveFleetRun } from './services/fleet.js'
import { cancelAll, hasActiveTransfer } from './services/transfers.js'

// ESM has no __dirname. import.meta.dirname exists in Electron 33's Node 20.18,
// but fileURLToPath keeps this working on anything older too.
// Note on the Chromium sandbox: when neither the namespace sandbox nor a
// correctly configured SUID helper is available, Electron aborts with SIGTRAP
// *before this file is executed* — verified by injecting a marker as the first
// statement and never seeing it. Nothing here can detect or recover from it;
// only a --no-sandbox argument from outside can, which is why the installer
// writes a launcher that decides before starting the app.
const here = join(fileURLToPath(import.meta.url), '..')

const isDev = !app.isPackaged && process.env.DISKPUSH_DEV === '1'
const DEV_URL = 'http://localhost:3210'

/**
 * Pinned before the app is ready, because Chromium reads it when it creates
 * the window: a taskbar matches WM_CLASS against a .desktop file's
 * StartupWMClass, and left to itself Chromium derives WM_CLASS from the
 * executable name — different for the deb, the AppImage and a dev run.
 */
app.commandLine.appendSwitch('class', WM_CLASS)

/** The window icon, which is also what a taskbar draws for the running app. */
function iconPath(): string | undefined {
  return resolveIconPath(
    [join(process.resourcesPath, 'icon.png'), join(here, '..', '..', 'resources', 'icon.png')],
    existsSync,
  )
}

/**
 * The exported renderer is served over a real scheme rather than loaded from
 * file://.
 *
 * Next emits root-absolute asset URLs (`/_next/static/...`) and refuses to emit
 * relative ones — `next/font` rejects an assetPrefix without a leading slash.
 * Under file:// those resolve against the filesystem root, so every stylesheet
 * and chunk 404s: the window shows unstyled prerendered HTML that never
 * hydrates. A standard scheme gives the bundle an origin, so the same absolute
 * paths resolve inside it, and CSP `'self'` means the bundle instead of the
 * whole disk.
 */
const APP_SCHEME = 'diskpush-app'
const APP_ORIGIN = `${APP_SCHEME}://bundle`

// Must run before the app is ready, hence module scope rather than whenReady.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

function bundleRoot(): string {
  return normalize(join(here, '..', '..', 'out'))
}

/**
 * The policy, computed once from the export the app will actually serve.
 *
 * Read eagerly rather than per request: the hashes come from index.html, and a
 * policy that silently fell back to one without them would blank the window.
 */
let policy: string | null = null
function bundlePolicy(): string {
  if (policy === null) {
    try {
      policy = contentSecurityPolicy(inlineScriptHashes(readFileSync(join(bundleRoot(), 'index.html'), 'utf8')))
    } catch {
      policy = contentSecurityPolicy()
    }
  }
  return policy
}

/** Serves the exported renderer, and nothing outside it. */
function serveBundle(): void {
  const root = bundleRoot()
  protocol.handle(APP_SCHEME, async (request) => {
    const target = resolveBundlePath(root, new URL(request.url).pathname)
    if (!target) return new Response('Forbidden', { status: 403 })
    try {
      const body = await readFile(target)
      return new Response(body, {
        headers: {
          'content-type': contentTypeFor(target),
          // Carried on the response itself, so the document is governed by the
          // policy whether or not a webRequest listener is attached.
          'content-security-policy': bundlePolicy(),
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function createWindow(): BrowserWindow {
  const icon = iconPath()
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0c10',
    title: 'DiskPush',
    // Without this the window carries no _NET_WM_ICON and the taskbar draws a
    // placeholder, which is what an app launched directly rather than from its
    // .desktop file always looked like.
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.cjs'),
      // The renderer gets no Node, no remote module, and its own sandbox. It
      // reaches the outside world only through the narrow IPC surface in
      // ipc.ts, and every message there is validated.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  // Navigation is pinned to the app itself. A renderer compromise should not
  // be able to point the window at somewhere else.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith(APP_ORIGIN)
    if (!allowed) event.preventDefault()
  })

  // External links open in the system browser, never in a new Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [bundlePolicy()],
      },
    })
  })

  if (isDev) void window.loadURL(DEV_URL)
  else void window.loadURL(`${APP_ORIGIN}/index.html`)

  return window
}

app.whenReady().then(() => {
  registerIpc()
  if (!isDev) serveBundle()
  createWindow()

  // Not awaited: a slow or unreachable GitHub must not delay the window.
  // A fleet upgrade counts as busy too: restarting the app under an
  // `apt upgrade` running on eight servers would drop every live connection
  // mid-transaction.
  void checkForUpdates(() => hasActiveTransfer() || hasActiveFleetRun())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Stopping with SIGINT leaves rsync's partial files intact, so anything in
  // flight is resumable rather than lost.
  cancelAll()
  cancelAllFleetRuns()
  closeAllSessions()
})
