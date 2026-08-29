import { parseRsyncCapabilities, unknownCapabilities, type RsyncCapabilities } from '@diskpush/rsync-core'
import { shellQuote } from '@diskpush/rsync-core'
import type { SshSession } from './session.js'

export type ConnectionReport = {
  ssh: boolean
  sftp: boolean
  rsync: boolean
  rsyncVersion: string | null
  capabilities: RsyncCapabilities
  homeDirectory: string | null
  /** Human-readable notes for the connection test panel. */
  notes: string[]
}

/**
 * Probes a live session.
 *
 * SFTP and rsync are checked independently on purpose: a host with SFTP but
 * no rsync is still fully browsable, and DiskPush says so rather than
 * refusing the connection outright.
 */
export async function probeConnection(session: SshSession, rsyncPath: string | null = null): Promise<ConnectionReport> {
  const notes: string[] = []
  const binary = rsyncPath ?? 'rsync'

  let sftp = false
  try {
    const handle = await session.sftp()
    handle.end()
    sftp = true
  } catch (error) {
    notes.push(`SFTP subsystem unavailable: ${(error as Error).message}`)
  }

  const version = await session.exec(`${shellQuote(binary)} --version`)
  const rsyncAvailable = version.code === 0 && /rsync\s+version/i.test(version.stdout)
  const capabilities = rsyncAvailable ? parseRsyncCapabilities(version.stdout) : unknownCapabilities()

  if (!rsyncAvailable) {
    notes.push(
      'rsync was not found on this server. Browsing works, but transfers are disabled until it is installed ' +
        '(Debian/Ubuntu: sudo apt install rsync).',
    )
  }

  const home = await session.exec('printf %s "$HOME"')

  return {
    ssh: true,
    sftp,
    rsync: rsyncAvailable,
    rsyncVersion: capabilities.version?.raw ?? null,
    capabilities,
    homeDirectory: home.code === 0 && home.stdout.trim() !== '' ? home.stdout.trim() : null,
    notes,
  }
}
