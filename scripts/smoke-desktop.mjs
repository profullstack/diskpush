#!/usr/bin/env node
/**
 * Smoke test for the Electron main process.
 *
 * Launching without a display fails at the display, and that is the point: if
 * the process gets as far as "Missing X server" then main, preload and every
 * module they import loaded successfully. Anything earlier is a real fault.
 *
 * This exists because a packaging change made the main process CommonJS while
 * the workspace packages stayed ESM, and the app died on launch with
 * ERR_REQUIRE_ESM. Nothing caught it: tsc typechecks module syntax, not module
 * *format* compatibility at runtime, and the unit tests never start Electron.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '..', 'apps', 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist', 'electron')

if (!existsSync(electron)) {
  console.error('electron binary not found; run pnpm install first.')
  process.exit(1)
}
if (!existsSync(join(desktop, 'dist-electron', 'main', 'index.js'))) {
  console.error('dist-electron is missing; run pnpm --filter @diskpush/desktop build first.')
  process.exit(1)
}

const result = spawnSync(electron, ['.', '--no-sandbox'], {
  cwd: desktop,
  encoding: 'utf8',
  timeout: 60_000,
  env: { ...process.env, DISKPUSH_NO_AUTO_UPDATE: '1' },
})

const stderr = `${result.stderr ?? ''}`

// A machine with no GUI libraries at all cannot run the binary, which says
// nothing about the application. Skip rather than report a failure the code
// cannot cause or fix.
if (/error while loading shared libraries/i.test(stderr)) {
  const missing = /shared libraries: ([^:]+):/.exec(stderr)?.[1] ?? 'a GUI library'
  console.log(`skipped: this machine cannot run Electron (${missing} is missing).`)
  process.exit(0)
}

if (/JavaScript error occurred in the main process/i.test(stderr) || /ERR_REQUIRE_ESM|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(stderr)) {
  console.error('FAIL: the main process threw before it could start.\n')
  console.error(stderr.slice(0, 2000))
  process.exit(1)
}

// On a machine with a display the window opens and the app keeps running until
// the timeout; on a headless one it exits here. Both mean main loaded.
if (/Missing X server|The platform failed to initialize/i.test(stderr) || result.signal === 'SIGTERM') {
  console.log('ok: the main process loaded (it only failed to find a display).')
  process.exit(0)
}

if (result.status === 0) {
  console.log('ok: the main process started and exited cleanly.')
  process.exit(0)
}

console.error('FAIL: unexpected startup output.\n')
console.error(stderr.slice(0, 2000))
process.exit(1)
