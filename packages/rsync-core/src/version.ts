/**
 * rsync version detection and capability gating.
 *
 * Feature availability is not cosmetic here: `--secluded-args` in particular
 * decides whether a remote path is interpreted by the remote login shell.
 */

export type RsyncVersion = { major: number; minor: number; patch: number; raw: string }

export type RsyncCapabilities = {
  version: RsyncVersion | null
  protocol: number | null
  /** `--compress-choice=zstd` (3.2.0+, and only when built with zstd). */
  zstd: boolean
  /** Remote args are shielded from the remote shell without a flag (3.2.4+). */
  secludedArgsByDefault: boolean
  /** `--protect-args` / `--secluded-args` exists at all (3.0.0+). */
  secludedArgsAvailable: boolean
  /** `--mkpath` (3.2.3+). */
  mkpath: boolean
  acls: boolean
  xattrs: boolean
  hardLinks: boolean
}

const UNKNOWN: RsyncCapabilities = {
  version: null,
  protocol: null,
  zstd: false,
  secludedArgsByDefault: false,
  secludedArgsAvailable: false,
  mkpath: false,
  acls: false,
  xattrs: false,
  hardLinks: true,
}

export function parseRsyncVersion(text: string): RsyncVersion | null {
  const match = /rsync\s+version\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3] ?? 0}`,
  }
}

export function compareVersion(a: RsyncVersion, major: number, minor: number, patch = 0): number {
  if (a.major !== major) return a.major - major
  if (a.minor !== minor) return a.minor - minor
  return a.patch - patch
}

export function atLeast(version: RsyncVersion | null, major: number, minor: number, patch = 0): boolean {
  if (!version) return false
  return compareVersion(version, major, minor, patch) >= 0
}

/**
 * Parses the full `rsync --version` banner, including the capability lines
 * ("Optimizations:", "Capabilities:", "Compress list:") that tell us what the
 * binary was actually built with rather than what its version implies.
 */
export function parseRsyncCapabilities(banner: string): RsyncCapabilities {
  const version = parseRsyncVersion(banner)
  if (!version) return { ...UNKNOWN }

  const lower = banner.toLowerCase()
  const protocolMatch = /protocol\s+version\s+(\d+)/i.exec(banner)

  // The compress list is authoritative for zstd; the version only makes it possible.
  const compressList = /compress list:\s*([^\n]*)/i.exec(lower)
  const zstd = compressList ? /\bzstd\b/.test(compressList[1] ?? '') : false

  return {
    version,
    protocol: protocolMatch ? Number(protocolMatch[1]) : null,
    zstd,
    secludedArgsByDefault: atLeast(version, 3, 2, 4),
    secludedArgsAvailable: atLeast(version, 3, 0, 0),
    mkpath: atLeast(version, 3, 2, 3),
    acls: /\bACLs\b/i.test(banner) && !/no ACLs/i.test(banner),
    xattrs: /\bxattrs\b/i.test(banner) && !/no xattrs/i.test(banner),
    hardLinks: !/no hardlinks/i.test(lower),
  }
}

export function unknownCapabilities(): RsyncCapabilities {
  return { ...UNKNOWN }
}

/**
 * The effective capability set for a transfer is the intersection of both
 * ends: a flag only one side understands will fail the run.
 */
export function intersectCapabilities(a: RsyncCapabilities, b: RsyncCapabilities | null): RsyncCapabilities {
  if (!b) return a
  const older = !a.version ? b : !b.version ? a : compareVersion(a.version, b.version.major, b.version.minor, b.version.patch) <= 0 ? a : b
  return {
    version: older.version,
    protocol: a.protocol !== null && b.protocol !== null ? Math.min(a.protocol, b.protocol) : (a.protocol ?? b.protocol),
    zstd: a.zstd && b.zstd,
    // Both ends must default to secluded args before we can skip the flag.
    secludedArgsByDefault: a.secludedArgsByDefault && b.secludedArgsByDefault,
    secludedArgsAvailable: a.secludedArgsAvailable && b.secludedArgsAvailable,
    mkpath: a.mkpath && b.mkpath,
    acls: a.acls && b.acls,
    xattrs: a.xattrs && b.xattrs,
    hardLinks: a.hardLinks && b.hardLinks,
  }
}
