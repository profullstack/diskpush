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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '..', 'apps', 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist', 'electron')

/**
 * Every asset the exported page asks for must resolve to a real file through
 * the same function that serves it.
 *
 * The launch check below cannot see this: it dies at the display, so the
 * renderer never runs. That is exactly how v0.2.0 shipped a window in which
 * the stylesheet and all five chunks 404ed — Next emits root-absolute URLs
 * (`/_next/static/...`), the app loaded the page over file://, and those
 * resolved against the filesystem root instead of the bundle. The result was
 * unstyled prerendered HTML that never hydrated, and nothing failed.
 */
async function checkRendererAssets() {
  const out = join(desktop, 'out')
  const index = join(out, 'index.html')
  if (!existsSync(index)) {
    console.error('out/index.html is missing; run pnpm --filter @diskpush/desktop build first.')
    process.exit(1)
  }

  const helper = join(desktop, 'dist-electron', 'main', 'bundle-path.js')
  if (!existsSync(helper)) {
    console.error('dist-electron is missing; run pnpm --filter @diskpush/desktop build first.')
    process.exit(1)
  }
  const { resolveBundlePath } = await import(helper)
  const html = readFileSync(index, 'utf8')
  // Only root-absolute references: those are the ones file:// resolved wrongly.
  const referenced = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1])

  if (referenced.length === 0) {
    console.error('FAIL: no assets referenced by out/index.html — the export looks broken.')
    process.exit(1)
  }

  const missing = referenced.filter((url) => {
    const target = resolveBundlePath(out, url.split(/[?#]/)[0])
    return !target || !existsSync(target)
  })

  if (missing.length > 0) {
    console.error(`FAIL: ${missing.length} of ${referenced.length} renderer assets do not resolve inside the bundle.\n`)
    missing.slice(0, 10).forEach((url) => console.error(`  ${url}`))
    console.error('\nThe window would render unstyled and never hydrate.')
    process.exit(1)
  }

  console.log(`ok: all ${referenced.length} renderer assets resolve inside the bundle.`)
}

/**
 * The renderer must not be loaded over file:// again.
 *
 * Checking that the assets resolve is not enough on its own: they resolve
 * whatever the window does with them. What broke the app was the *origin* —
 * loadFile gives the page a file:// origin, under which the root-absolute URLs
 * above point at the filesystem root rather than the bundle. So pin the
 * mechanism, not just the paths.
 */
function checkRendererDelivery() {
  const main = readFileSync(join(desktop, 'dist-electron', 'main', 'index.js'), 'utf8')

  if (!main.includes('registerSchemesAsPrivileged')) {
    console.error('FAIL: the main process no longer registers a scheme for the bundle.')
    process.exit(1)
  }
  if (/\.loadFile\s*\(/.test(main)) {
    console.error('FAIL: the main process loads the renderer with loadFile, which gives it a file:// origin.')
    console.error("Next's root-absolute asset URLs resolve against the filesystem root there, so the")
    console.error('window renders unstyled and never hydrates. Serve the bundle over its scheme instead.')
    process.exit(1)
  }

  console.log('ok: the renderer is served over its own scheme, not file://.')
}

/**
 * The policy the window will send must admit every inline script in the export.
 *
 * Serving the assets correctly is not sufficient: a Next export carries its
 * Flight payload in inline `<script>` tags, and `script-src 'self'` refuses
 * them. That shipped in v0.2.1 — the chunks loaded, React booted with no
 * payload, and the window was blank. Assets loading and the page rendering are
 * different facts, and only this one catches the second.
 */
async function checkPolicyAdmitsPayload() {
  const { contentSecurityPolicy, inlineScriptHashes } = await import(join(desktop, 'dist-electron', 'main', 'csp.js'))
  const html = readFileSync(join(desktop, 'out', 'index.html'), 'utf8')
  const hashes = inlineScriptHashes(html)

  if (hashes.length === 0) {
    console.error('FAIL: no inline scripts found in the export — the hashing no longer matches what Next emits.')
    console.error('A policy computed from this would blank the window.')
    process.exit(1)
  }

  const policy = contentSecurityPolicy(hashes)
  const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src')) ?? ''
  const unadmitted = hashes.filter((hash) => !scriptSrc.includes(hash))

  if (unadmitted.length > 0) {
    console.error(`FAIL: ${unadmitted.length} inline scripts are not admitted by script-src; the window would be blank.`)
    process.exit(1)
  }

  console.log(`ok: the policy admits all ${hashes.length} inline payload scripts.`)
}

await checkRendererAssets()
checkRendererDelivery()
await checkPolicyAdmitsPayload()

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
