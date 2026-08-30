import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpc } from './ipc.js'
import { checkForUpdates } from './services/updater.js'
import { closeAllSessions } from './services/sessions.js'
import { cancelAll, hasActiveTransfer } from './services/transfers.js'

// ESM has no __dirname. import.meta.dirname exists in Electron 33's Node 20.18,
// but fileURLToPath keeps this working on anything older too.
const here = join(fileURLToPath(import.meta.url), '..')

const isDev = !app.isPackaged && process.env.DISKPUSH_DEV === '1'
const DEV_URL = 'http://localhost:3210'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0c10',
    title: 'DiskPush',
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
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://')
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
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            // Next's exported bundle inlines a small amount of style.
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            // The renderer talks to the main process over IPC, not the network.
            "connect-src 'self'",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
        ],
      },
    })
  })

  if (isDev) void window.loadURL(DEV_URL)
  else void window.loadFile(join(here, '..', '..', 'out', 'index.html'))

  return window
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  // Not awaited: a slow or unreachable GitHub must not delay the window.
  void checkForUpdates(hasActiveTransfer)

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
  closeAllSessions()
})
