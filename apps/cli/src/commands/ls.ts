import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DiskPushStore } from '@diskpush/database'
import { knownHostsPath } from '@diskpush/database'
import { SftpBrowser, SshSession } from '@diskpush/ssh-core'
import { EXIT } from '../exit-codes.js'
import { formatBytes, table } from '../format.js'
import { failure, type Output } from '../output.js'
import type { ParsedArgv } from '../parse-argv.js'
import { resolveEndpoint } from '../resolve.js'

/** Directory listing for either side, using the same endpoint grammar as a transfer. */
export async function runLs(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const target = parsed.positionals[0] ?? '.'
  const resolved = await resolveEndpoint(store, target)

  if (resolved.endpoint.type === 'local') {
    return listLocal(resolved.endpoint.path, output)
  }
  if (!resolved.connection) {
    return failure(
      output,
      `${resolved.endpoint.host} is neither a saved connection nor a host in ~/.ssh/config.\n` +
        `Add it with: diskpush connections add ${resolved.endpoint.host} user@${resolved.endpoint.host}`,
      EXIT.configuration,
    )
  }

  let session: SshSession
  try {
    session = await SshSession.connect(resolved.connection, { knownHostsPath: knownHostsPath() })
  } catch (error) {
    return failure(output, (error as Error).message, EXIT.unavailable)
  }

  try {
    const browser = await SftpBrowser.open(session)
    const entries = await browser.list(resolved.endpoint.path)
    browser.close()

    if (output.isJson) {
      output.json({ status: 'ok', path: resolved.endpoint.path, entries })
      return EXIT.ok
    }
    output.line(
      table(
        entries.map((entry) => [
          entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-',
          entry.mode.toString(8).padStart(4, '0'),
          formatBytes(entry.size),
          entry.modifiedAt.slice(0, 16).replace('T', ' '),
          entry.name,
        ]),
        ['T', 'MODE', 'SIZE', 'MODIFIED', 'NAME'],
      ),
    )
    return EXIT.ok
  } catch (error) {
    return failure(output, (error as Error).message, EXIT.unavailable)
  } finally {
    session.close()
  }
}

function listLocal(path: string, output: Output): number {
  let names: string[]
  try {
    names = readdirSync(path)
  } catch (error) {
    return failure(output, (error as Error).message, EXIT.configuration)
  }

  const entries = names.map((name) => {
    const stats = statSync(join(path, name), { throwIfNoEntry: false })
    return {
      name,
      type: stats?.isDirectory() ? 'directory' : stats?.isSymbolicLink() ? 'symlink' : 'file',
      size: stats?.size ?? 0,
      modifiedAt: stats ? stats.mtime.toISOString() : '',
      mode: stats ? stats.mode & 0o7777 : 0,
    }
  })

  if (output.isJson) {
    output.json({ status: 'ok', path, entries })
    return EXIT.ok
  }
  output.line(
    table(
      entries.map((entry) => [
        entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-',
        entry.mode.toString(8).padStart(4, '0'),
        formatBytes(entry.size),
        entry.modifiedAt.slice(0, 16).replace('T', ' '),
        entry.name,
      ]),
      ['T', 'MODE', 'SIZE', 'MODIFIED', 'NAME'],
    ),
  )
  return EXIT.ok
}
