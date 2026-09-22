import { describe, expect, it } from 'vitest'
import { atLeast, intersectCapabilities, parseRsyncCapabilities, parseRsyncVersion } from './version.js'

const RSYNC_341 = `rsync  version 3.4.1  protocol version 32
Copyright (C) 1996-2025 by Andrew Tridgell, Wayne Davison, and others.
Capabilities:
    64-bit files, 64-bit inums, 64-bit timestamps, 64-bit long ints,
    socketpairs, symlinks, symtimes, hardlinks, hardlink-specials,
    ACLs, xattrs, optional protect-args, iconv, prealloc, stop-at, no crtimes
Optimizations:
    SIMD-roll, no asm-roll, openssl-crypto, no asm-MD5
Checksum list:
    xxh128 xxh3 xxh64 md5 md4 sha1 none
Compress list:
    zstd lz4 zlibx zlib none`

const RSYNC_351 = `rsync  version 3.5.1  protocol version 33
Copyright (C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.
Capabilities:
    64-bit files, 64-bit inums, 64-bit timestamps, 64-bit long ints,
    socketpairs, symlinks, symtimes, hardlinks, hardlink-specials,
    hardlink-symlinks, IPv6, atimes, batchfiles, inplace, append, ACLs,
    xattrs, optional secluded-args, iconv, prealloc, stop-at, no crtimes
Optimizations:
    SIMD-roll, no asm-roll, openssl-crypto, no asm-MD5
Checksum list:
    xxh128 xxh3 xxh64 md5 md4 sha1 none
Compress list:
    zstd lz4 zlibx zlib none`

const RSYNC_316 = `rsync  version 3.1.6  protocol version 31
Capabilities:
    64-bit files, socketpairs, hardlinks, symlinks, ACLs, xattrs, protect-args
Compress list:
    zlibx zlib none`

const RSYNC_2612 = `rsync  version 2.6.9  protocol version 29
Capabilities:
    64-bit files, socketpairs, hardlinks, symlinks, no ACLs, no xattrs`

describe('parseRsyncVersion', () => {
  it('reads major.minor.patch', () => {
    expect(parseRsyncVersion(RSYNC_341)).toMatchObject({ major: 3, minor: 4, patch: 1 })
  })

  it('reads 3.5.1, the current release', () => {
    expect(parseRsyncVersion(RSYNC_351)).toMatchObject({ major: 3, minor: 5, patch: 1, raw: '3.5.1' })
  })

  it('defaults a missing patch to zero', () => {
    expect(parseRsyncVersion('rsync  version 3.2  protocol version 31')).toMatchObject({ major: 3, minor: 2, patch: 0 })
  })

  it('returns null for output that is not an rsync banner', () => {
    expect(parseRsyncVersion('bash: rsync: command not found')).toBeNull()
  })
})

describe('parseRsyncCapabilities', () => {
  it('reads zstd from the compress list, not from the version', () => {
    expect(parseRsyncCapabilities(RSYNC_341).zstd).toBe(true)
    expect(parseRsyncCapabilities(RSYNC_316).zstd).toBe(false)
  })

  it('knows 3.4.1 secludes remote args by default', () => {
    const caps = parseRsyncCapabilities(RSYNC_341)
    expect(caps.secludedArgsByDefault).toBe(true)
    expect(caps.secludedArgsAvailable).toBe(true)
  })

  it('knows 3.1.6 has protect-args but does not apply it by default', () => {
    const caps = parseRsyncCapabilities(RSYNC_316)
    expect(caps.secludedArgsByDefault).toBe(false)
    expect(caps.secludedArgsAvailable).toBe(true)
  })

  it('knows 2.6.9 cannot protect remote args at all', () => {
    const caps = parseRsyncCapabilities(RSYNC_2612)
    expect(caps.secludedArgsAvailable).toBe(false)
    expect(caps.acls).toBe(false)
    expect(caps.xattrs).toBe(false)
  })

  it('gates --mkpath on 3.2.3', () => {
    expect(parseRsyncCapabilities(RSYNC_341).mkpath).toBe(true)
    expect(parseRsyncCapabilities(RSYNC_316).mkpath).toBe(false)
  })

  it('reads protocol 33 from 3.5.1 and keeps every older capability', () => {
    const caps = parseRsyncCapabilities(RSYNC_351)
    expect(caps.protocol).toBe(33)
    expect(caps.secludedArgsByDefault).toBe(true)
    expect(caps.mkpath).toBe(true)
    expect(caps.zstd).toBe(true)
    expect(caps.acls).toBe(true)
    expect(caps.xattrs).toBe(true)
  })

  it('gates the 4 KiB block stat on protocol 33', () => {
    expect(parseRsyncCapabilities(RSYNC_351).blockStats).toBe(true)
    expect(parseRsyncCapabilities(RSYNC_341).blockStats).toBe(false)
    expect(parseRsyncCapabilities(RSYNC_316).blockStats).toBe(false)
  })

  it('falls back to the version when the banner prints no protocol line', () => {
    expect(parseRsyncCapabilities('rsync  version 3.5.1').blockStats).toBe(true)
    expect(parseRsyncCapabilities('rsync  version 3.4.1').blockStats).toBe(false)
  })
})

describe('atLeast', () => {
  it('compares patch levels', () => {
    const v = parseRsyncVersion('rsync  version 3.2.3')!
    expect(atLeast(v, 3, 2, 3)).toBe(true)
    expect(atLeast(v, 3, 2, 4)).toBe(false)
  })

  it('is false when the version is unknown', () => {
    expect(atLeast(null, 3, 0)).toBe(false)
  })
})

describe('intersectCapabilities', () => {
  it('drops the block stat unless both ends speak protocol 33', () => {
    const modern = parseRsyncCapabilities(RSYNC_351)
    expect(intersectCapabilities(modern, parseRsyncCapabilities(RSYNC_341)).blockStats).toBe(false)
    expect(intersectCapabilities(modern, modern).blockStats).toBe(true)
    expect(intersectCapabilities(modern, parseRsyncCapabilities(RSYNC_341)).protocol).toBe(32)
  })

  it('takes the weaker of the two ends', () => {
    const merged = intersectCapabilities(parseRsyncCapabilities(RSYNC_341), parseRsyncCapabilities(RSYNC_316))
    expect(merged.zstd).toBe(false)
    expect(merged.secludedArgsByDefault).toBe(false)
    expect(merged.mkpath).toBe(false)
    expect(merged.version?.raw).toBe('3.1.6')
  })

  it('returns the local side untouched when the remote is unknown', () => {
    const local = parseRsyncCapabilities(RSYNC_341)
    expect(intersectCapabilities(local, null)).toEqual(local)
  })
})
