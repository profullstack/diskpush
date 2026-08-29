import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultRsyncOptions } from '@diskpush/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseEndpoint, parseRsyncCapabilities, planTransfer, runToCompletion } from '@diskpush/rsync-core'

/**
 * Integration tests against a real SSH server.
 *
 * Skipped unless DISKPUSH_TEST_SSH=1, so a checkout with no Docker still runs
 * green. See docker/test-ssh-server/README.md.
 */
const enabled = process.env.DISKPUSH_TEST_SSH === '1'
const HOST = process.env.DISKPUSH_TEST_SSH_HOST ?? 'localhost'
const PORT = Number(process.env.DISKPUSH_TEST_SSH_PORT ?? 2222)
const USER = process.env.DISKPUSH_TEST_SSH_USER ?? 'diskpush'
const KEY = process.env.DISKPUSH_TEST_SSH_KEY ?? join(process.cwd(), 'docker', 'test-ssh-server', 'test_key')

let root: string
let capabilities: ReturnType<typeof parseRsyncCapabilities>

beforeAll(() => {
  if (!enabled) return
  root = mkdtempSync(join(tmpdir(), 'diskpush-int-'))
  capabilities = parseRsyncCapabilities(execFileSync('rsync', ['--version'], { encoding: 'utf8' }))
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const shell = () => ({
  port: PORT,
  keyPath: KEY,
  // The container is rebuilt per run, so its host key is new every time.
  extraOptions: ['UserKnownHostsFile=/dev/null'],
})

function remote(path: string) {
  return parseEndpoint(`${USER}@${HOST}:${path}`)
}

describe.skipIf(!enabled)('integration: local to remote', () => {
  it('uploads a tree and skips it on the second run', async () => {
    const src = join(root, 'upload')
    mkdirSync(src, { recursive: true })
    for (let i = 0; i < 20; i += 1) writeFileSync(join(src, `f${i}.txt`), `contents ${i}`)

    const destination = `/data/upload-${Date.now()}/`
    const plan = () =>
      planTransfer({
        source: parseEndpoint(`${src}/`),
        destination: remote(destination),
        options: defaultRsyncOptions({ stats: true, mkpath: capabilities.mkpath }),
        capabilities,
        remoteShell: shell(),
      })

    const first = await runToCompletion(plan())
    expect(first.ok).toBe(true)
    expect(first.stats?.filesTransferred).toBe(20)

    const second = await runToCompletion(plan())
    expect(second.ok).toBe(true)
    expect(second.stats?.filesTransferred).toBe(0)
  }, 60_000)

  it('treats a remote path containing shell metacharacters as a path', async () => {
    const src = join(root, 'hostile')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'payload.txt'), 'safe')

    // Without secluded/protected args this is remote code execution. With
    // them, it is a directory whose name happens to contain punctuation.
    const destination = `/data/weird $(touch /tmp/PWNED); \`id\`/`
    const result = await runToCompletion(
      planTransfer({
        source: parseEndpoint(`${src}/`),
        destination: remote(destination),
        options: defaultRsyncOptions({ mkpath: capabilities.mkpath }),
        capabilities,
        remoteShell: shell(),
      }),
    )
    expect(result.ok).toBe(true)

    const check = execFileSync('ssh', [
      '-i', KEY, '-p', String(PORT),
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      `${USER}@${HOST}`,
      'test -e /tmp/PWNED && echo PWNED || echo clean',
    ], { encoding: 'utf8' })
    expect(check.trim()).toBe('clean')
  }, 60_000)
})

describe.skipIf(!enabled)('integration: pulling back', () => {
  it('downloads what it uploaded, byte for byte', async () => {
    const src = join(root, 'roundtrip-src')
    const back = join(root, 'roundtrip-back')
    mkdirSync(src, { recursive: true })
    mkdirSync(back, { recursive: true })
    const payload = Buffer.alloc(512 * 1024, 3)
    writeFileSync(join(src, 'blob.bin'), payload)

    const remotePath = `/data/roundtrip-${Date.now()}/`
    const up = await runToCompletion(
      planTransfer({
        source: parseEndpoint(`${src}/`),
        destination: remote(remotePath),
        options: defaultRsyncOptions({ mkpath: capabilities.mkpath }),
        capabilities,
        remoteShell: shell(),
      }),
    )
    expect(up.ok).toBe(true)

    const down = await runToCompletion(
      planTransfer({
        source: remote(remotePath),
        destination: parseEndpoint(`${back}/`),
        options: defaultRsyncOptions(),
        capabilities,
        remoteShell: shell(),
      }),
    )
    expect(down.ok).toBe(true)
    expect(readFileSync(join(back, 'blob.bin')).equals(payload)).toBe(true)
  }, 60_000)
})
