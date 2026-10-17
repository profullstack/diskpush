import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { onPath, pickFetcher } from './fetcher.js'

function binDir(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dp-fetcher-'))
  for (const name of names) {
    writeFileSync(join(dir, name), '#!/bin/sh\n')
    chmodSync(join(dir, name), 0o755)
  }
  return dir
}

describe('pickFetcher', () => {
  it('prefers curl, falls back to wget, and finds them without a shell', () => {
    const both = binDir('curl', 'wget')
    expect(pickFetcher({ PATH: both })).toEqual({ binary: join(both, 'curl'), args: ['-fsSL'] })
    const wgetOnly = binDir('wget')
    expect(pickFetcher({ PATH: wgetOnly })).toEqual({ binary: join(wgetOnly, 'wget'), args: ['-qO-'] })
    expect(pickFetcher({ PATH: binDir() })).toBeNull()
  })

  it('ignores files that are not executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-fetcher-'))
    writeFileSync(join(dir, 'curl'), 'not a program')
    chmodSync(join(dir, 'curl'), 0o644)
    expect(onPath('curl', { PATH: dir })).toBeNull()
  })
})
