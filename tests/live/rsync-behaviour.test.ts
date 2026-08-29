import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultRsyncOptions } from '@diskpush/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseEndpoint, parseRsyncCapabilities, planTransfer, runToCompletion } from '@diskpush/rsync-core'

/**
 * These run the real rsync binary on the local filesystem.
 *
 * They are the acceptance tests from the PRD that do not need a second host:
 * unchanged files are skipped, one changed file transfers alone, archive
 * metadata survives, mirror deletes only after confirmation, and a path full
 * of shell metacharacters stays a path.
 */

let root: string
let capabilities: ReturnType<typeof parseRsyncCapabilities>

const hasRsync = (() => {
  try {
    execFileSync('rsync', ['--version'], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
})()

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'diskpush-live-'))
  capabilities = parseRsyncCapabilities(execFileSync('rsync', ['--version'], { encoding: 'utf8' }))
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function tree(name: string): { src: string; dst: string } {
  const src = join(root, name, 'src')
  const dst = join(root, name, 'dst')
  mkdirSync(src, { recursive: true })
  mkdirSync(dst, { recursive: true })
  return { src, dst }
}

function sync(src: string, dst: string, options = defaultRsyncOptions(), deletesConfirmed = false) {
  const plan = planTransfer({
    source: parseEndpoint(`${src}/`),
    destination: parseEndpoint(`${dst}/`),
    options: { ...options, stats: true },
    capabilities,
    deletesConfirmed,
  })
  return runToCompletion(plan)
}

describe.skipIf(!hasRsync)('live rsync: DiskPush defaults', () => {
  it('copies a tree with the default preset and reports what it added', async () => {
    const { src, dst } = tree('basic')
    writeFileSync(join(src, 'a.txt'), 'alpha')
    mkdirSync(join(src, 'nested'))
    writeFileSync(join(src, 'nested', 'b.txt'), 'beta')

    const result = await sync(src, dst)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dst, 'nested', 'b.txt'), 'utf8')).toBe('beta')
    expect(result.changes.filter((c) => c.action === 'add').map((c) => c.path)).toContain('a.txt')
  })

  it('transfers essentially nothing on a second identical run', async () => {
    const { src, dst } = tree('unchanged')
    for (let i = 0; i < 200; i += 1) writeFileSync(join(src, `f${i}.txt`), `contents ${i}`)

    const first = await sync(src, dst)
    expect(first.ok).toBe(true)
    expect(first.stats?.filesTransferred).toBe(200)

    const second = await sync(src, dst)
    expect(second.ok).toBe(true)
    expect(second.stats?.filesTransferred).toBe(0)
    expect(second.changes.filter((c) => c.action === 'add' || c.action === 'update')).toHaveLength(0)
  })

  it('transfers only the file that changed', async () => {
    const { src, dst } = tree('one-change')
    for (let i = 0; i < 50; i += 1) writeFileSync(join(src, `f${i}.txt`), `contents ${i}`)
    await sync(src, dst)

    writeFileSync(join(src, 'f7.txt'), 'contents 7 modified')
    const result = await sync(src, dst)

    expect(result.stats?.filesTransferred).toBe(1)
    const touched = result.changes.filter((c) => c.action === 'add' || c.action === 'update')
    expect(touched.map((c) => c.path)).toEqual(['f7.txt'])
  })

  it('preserves archive metadata: timestamps, permissions and symlinks', async () => {
    const { src, dst } = tree('archive')
    const file = join(src, 'script.sh')
    writeFileSync(file, '#!/bin/sh\necho hi\n', { mode: 0o755 })
    symlinkSync('script.sh', join(src, 'link.sh'))
    const when = new Date('2020-06-15T12:00:00Z')
    utimesSync(file, when, when)

    const result = await sync(src, dst)
    expect(result.ok).toBe(true)

    const copied = statSync(join(dst, 'script.sh'))
    expect(copied.mode & 0o777).toBe(0o755)
    expect(Math.abs(copied.mtime.getTime() - when.getTime())).toBeLessThan(1000)
    expect(statSync(join(dst, 'link.sh'), { bigint: false }).isFile()).toBe(true)
    expect(execFileSync('readlink', [join(dst, 'link.sh')], { encoding: 'utf8' }).trim()).toBe('script.sh')
  })

  it('leaves destination-only files alone without mirror mode', async () => {
    const { src, dst } = tree('non-destructive')
    writeFileSync(join(src, 'kept.txt'), 'from source')
    writeFileSync(join(dst, 'destination-only.txt'), 'do not delete me')

    await sync(src, dst)
    expect(readFileSync(join(dst, 'destination-only.txt'), 'utf8')).toBe('do not delete me')
  })
})

describe.skipIf(!hasRsync)('live rsync: mirror safety', () => {
  it('previews deletions without performing them', async () => {
    const { src, dst } = tree('mirror-preview')
    writeFileSync(join(src, 'kept.txt'), 'x')
    writeFileSync(join(dst, 'stale.txt'), 'y')

    const preview = await sync(src, dst, defaultRsyncOptions({ deleteMode: 'delay', dryRun: true }))
    expect(preview.ok).toBe(true)
    expect(preview.changes.filter((c) => c.action === 'delete').map((c) => c.path)).toEqual(['stale.txt'])

    // The dry run must not have touched anything.
    expect(readFileSync(join(dst, 'stale.txt'), 'utf8')).toBe('y')
  })

  it('deletes only after the preview is confirmed', async () => {
    const { src, dst } = tree('mirror-confirmed')
    writeFileSync(join(src, 'kept.txt'), 'x')
    writeFileSync(join(dst, 'stale.txt'), 'y')

    const result = await sync(src, dst, defaultRsyncOptions({ deleteMode: 'delay' }), true)
    expect(result.ok).toBe(true)
    expect(() => readFileSync(join(dst, 'stale.txt'))).toThrow()
    expect(readFileSync(join(dst, 'kept.txt'), 'utf8')).toBe('x')
  })
})

describe.skipIf(!hasRsync)('live rsync: hostile paths', () => {
  it('treats shell metacharacters in a path as part of the path', async () => {
    const { src, dst } = tree('injection')
    // No slashes: this has to be a legal single directory name, so the marker
    // is relative and rsync runs with the temp root as its working directory.
    const nasty = `weird $(touch PWNED-SUBST); \`touch PWNED-TICK\` 'quoted' "dq" & dir`
    mkdirSync(join(src, nasty))
    writeFileSync(join(src, nasty, 'payload.txt'), 'safe')

    const plan = planTransfer({
      source: parseEndpoint(`${src}/`),
      destination: parseEndpoint(`${dst}/`),
      options: defaultRsyncOptions(),
      capabilities,
    })
    const result = await runToCompletion(plan, { cwd: root })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dst, nasty, 'payload.txt'), 'utf8')).toBe('safe')
    expect(() => statSync(join(root, 'PWNED-SUBST'))).toThrow()
    expect(() => statSync(join(root, 'PWNED-TICK'))).toThrow()
  })

  it('copies a file whose name is a run of dashes without reading it as a flag', async () => {
    const { src, dst } = tree('dashes')
    writeFileSync(join(src, '--archive'), 'not a flag')

    const result = await sync(src, dst)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dst, '--archive'), 'utf8')).toBe('not a flag')
  })
})

describe.skipIf(!hasRsync)('live rsync: resume', () => {
  it('keeps partial data when a transfer is interrupted, and finishes on retry', async () => {
    const { src, dst } = tree('resume')
    // Large enough that a bandwidth limit guarantees the transfer is still
    // running when we interrupt it.
    const big = Buffer.alloc(6 * 1024 * 1024, 7)
    writeFileSync(join(src, 'big.bin'), big)

    const plan = planTransfer({
      source: parseEndpoint(`${src}/`),
      destination: parseEndpoint(`${dst}/`),
      options: defaultRsyncOptions({ bwlimit: '2M' }),
      capabilities,
    })

    const { runPlan } = await import('@diskpush/rsync-core')
    const handle = runPlan(plan)
    let interrupted = false
    const events: string[] = []
    for await (const event of handle.events) {
      events.push(event.type)
      if (event.type === 'progress' && event.progress.bytesTransferred > 1024 * 1024 && !interrupted) {
        interrupted = true
        handle.cancel()
      }
      if (event.type === 'exit') {
        expect(event.resumable).toBe(true)
      }
    }
    expect(interrupted).toBe(true)

    // The partial file is retained under the partial directory, not presented
    // as a finished copy of the original.
    const partial = join(dst, '.rsync-partial', 'big.bin')
    expect(statSync(partial).size).toBeGreaterThan(0)
    expect(statSync(partial).size).toBeLessThan(big.length)

    const retry = await sync(src, dst)
    expect(retry.ok).toBe(true)
    expect(readFileSync(join(dst, 'big.bin')).equals(big)).toBe(true)
  }, 60_000)
})
