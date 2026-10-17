import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { DiskPushStore } from '@diskpush/database'
import { knownHostsPath } from '@diskpush/database'
import { expandTilde, parseSshConfig, probeConnection, SshSession } from '@diskpush/ssh-core'
import { S3_SECRET_NAME, parseS3Url, s3ClientFor, s3DisplayFields } from '@diskpush/s3-core'
import { isS3Connection, type S3ConnectionSettings } from '@diskpush/schemas'
import { EXIT } from '../exit-codes.js'
import { table } from '../format.js'
import { failure, type Output } from '../output.js'
import { ArgvError, flagValue, hasFlag, type ParsedArgv } from '../parse-argv.js'
import { capabilityCacheKey } from '../resolve.js'
import { readSecret } from './fleet.js'

export async function runConnections(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const subcommand = parsed.positionals[0] ?? 'list'

  switch (subcommand) {
    case 'list':
      return listConnections(store, output)
    case 'test':
      return testConnection(parsed, store, output)
    case 'add':
      return addConnection(parsed, store, output)
    case 'remove':
    case 'rm':
      return removeConnection(parsed, store, output)
    case 'import':
      return importConnections(parsed, store, output)
    default:
      return failure(output, `Unknown subcommand ${JSON.stringify(subcommand)}. Try: list, test, add, remove, import.`, EXIT.usage)
  }
}

async function listConnections(store: DiskPushStore, output: Output): Promise<number> {
  const connections = await store.listConnections()
  if (output.isJson) {
    output.json({ status: 'ok', connections })
    return EXIT.ok
  }
  if (connections.length === 0) {
    output.line('No saved connections. Add one with: diskpush connections add NAME user@host')
    return EXIT.ok
  }
  const rows = await Promise.all(
    connections.map(async (c) =>
      isS3Connection(c)
        ? [
            c.name,
            `s3://${c.s3.bucket} @ ${c.host}`,
            String(c.port),
            (await store.getConnectionSecret(c.id, S3_SECRET_NAME)) ? 's3 key' : 's3 env',
            c.defaultRemotePath ?? '/',
          ]
        : [c.name, `${c.username}@${c.host}`, String(c.port), c.authType, c.defaultRemotePath ?? ''],
    ),
  )
  output.line(table(rows, ['NAME', 'TARGET', 'PORT', 'AUTH', 'DEFAULT PATH']))
  return EXIT.ok
}

async function testConnection(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const name = parsed.positionals[1]
  if (!name) return failure(output, 'Usage: diskpush connections test NAME', EXIT.usage)

  const connection = await store.findConnection(name)
  if (!connection) return failure(output, `No connection named ${JSON.stringify(name)}.`, EXIT.configuration)

  if (isS3Connection(connection)) {
    try {
      const client = s3ClientFor(connection.s3, await store.getConnectionSecret(connection.id, S3_SECRET_NAME), process.env, connection.name)
      const page = await client.list({ delimiter: '/', maxKeys: 20 })
      if (output.isJson) {
        output.json({ status: 'ok', connection: connection.name, bucket: connection.s3.bucket, endpoint: client.url('').origin, sample: page })
        return EXIT.ok
      }
      output.line(
        table([
          ['Endpoint', 'ok', client.url('').origin],
          ['Bucket', 'ok', `${connection.s3.bucket} (${connection.s3.region})`],
          ['Credentials', 'ok', connection.s3.accessKeyId ?? 'from AWS_ACCESS_KEY_ID'],
          ['Top level', 'ok', `${page.prefixes.length} folder(s), ${page.objects.length} object(s)${page.next ? ' and more' : ''}`],
        ]),
      )
      return EXIT.ok
    } catch (error) {
      return failure(output, (error as Error).message, EXIT.unavailable)
    }
  }

  let session: SshSession
  try {
    session = await SshSession.connect(connection, {
      knownHostsPath: knownHostsPath(),
      onUnknownHostKey: async (details) => {
        if (hasFlag(parsed, '--yes')) return true
        if (!process.stdin.isTTY) return false
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try {
          output.warn(`The authenticity of ${details.host} cannot be established.`)
          output.warn(`${details.keyType} key fingerprint is ${details.fingerprint}.`)
          const answer = await rl.question('Trust this host and add it to known_hosts? [y/N] ')
          return /^y(es)?$/i.test(answer.trim())
        } finally {
          rl.close()
        }
      },
    })
  } catch (error) {
    return failure(output, (error as Error).message, EXIT.unavailable)
  }

  try {
    const report = await probeConnection(session, connection.rsyncPath)
    // Cached so transfers can gate options on the remote's real capabilities
    // instead of assuming the local rsync's feature set applies to both ends.
    await store.setSetting(capabilityCacheKey(connection.id), report.capabilities)

    if (output.isJson) {
      output.json({ status: 'ok', connection: connection.name, report })
      return EXIT.ok
    }

    const mark = (ok: boolean) => (ok ? 'ok' : 'FAILED')
    output.line(
      table([
        ['SSH', mark(true), `${connection.username}@${connection.host}:${connection.port}`],
        ['SFTP browsing', mark(report.sftp), report.sftp ? 'available' : 'unavailable'],
        ['Remote rsync', mark(report.rsync), report.rsyncVersion ?? 'not found'],
        ['zstd compression', mark(report.capabilities.zstd), report.capabilities.zstd ? 'supported' : 'not supported'],
        ['ACL preservation', mark(report.capabilities.acls), report.capabilities.acls ? 'supported' : 'not supported'],
        ['xattr preservation', mark(report.capabilities.xattrs), report.capabilities.xattrs ? 'supported' : 'not supported'],
        ['Home directory', mark(report.homeDirectory !== null), report.homeDirectory ?? 'unknown'],
      ]),
    )
    for (const note of report.notes) output.warn(`\n${note}`)
    return report.rsync ? EXIT.ok : EXIT.ok
  } finally {
    session.close()
  }
}

async function addConnection(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const [, name, target] = parsed.positionals
  if (!name || !target) {
    return failure(
      output,
      'Usage: diskpush connections add NAME [user@]host [--port N] [--identity PATH]\n' +
        '       diskpush connections add NAME s3://BUCKET[/path] [--endpoint URL] [--region R] [--access-key-id ID] [--secret-stdin | --no-secret]',
      EXIT.usage,
    )
  }
  if (/^s3:\/\//i.test(target)) return addS3Connection(parsed, store, output, name, target)

  const at = target.lastIndexOf('@')
  const username = at === -1 ? (process.env.USER ?? 'root') : target.slice(0, at)
  const host = at === -1 ? target : target.slice(at + 1)
  const identity = flagValue(parsed, '--identity') ?? flagValue(parsed, '--key')

  const connection = await store.saveConnection({
    kind: 'ssh',
    s3: null,
    name,
    host,
    port: parsePort(flagValue(parsed, '--port')),
    username,
    authType: identity ? 'key' : 'agent',
    keyPath: identity ?? null,
    defaultLocalPath: null,
    defaultRemotePath: flagValue(parsed, '--path') ?? null,
    jumpHost: flagValue(parsed, '--jump') ?? null,
    rsyncPath: flagValue(parsed, '--rsync-path') ?? null,
    connectTimeoutSeconds: 15,
    keepaliveSeconds: 30,
    forwardAgent: hasFlag(parsed, '--forward-agent'),
    tags: [],
    notes: '',
  })

  if (output.isJson) output.json({ status: 'ok', connection })
  else output.line(`Saved connection ${connection.name} (${connection.username}@${connection.host}:${connection.port}).`)
  return EXIT.ok
}

/**
 * `connections add NAME s3://bucket[/path]`. The secret access key is asked
 * for on the terminal (never an argv flag, which shell history and `ps`
 * would keep), read from stdin with --secret-stdin, or left to
 * AWS_SECRET_ACCESS_KEY with --no-secret.
 */
async function addS3Connection(parsed: ParsedArgv, store: DiskPushStore, output: Output, name: string, target: string): Promise<number> {
  const url = parseS3Url(target)
  if (!url) return failure(output, `${target} is not s3://BUCKET[/path].`, EXIT.usage)
  const endpoint = flagValue(parsed, '--endpoint') ?? null
  if (endpoint !== null && !/^https?:\/\/[^/]+/.test(endpoint)) return failure(output, '--endpoint must be an http(s) URL.', EXIT.usage)
  const region = flagValue(parsed, '--region') ?? (endpoint && /r2\.cloudflarestorage\.com/.test(endpoint) ? 'auto' : 'us-east-1')
  const pathStyle = hasFlag(parsed, '--path-style') ? true : hasFlag(parsed, '--virtual-hosted') ? false : null
  const accessKeyId = flagValue(parsed, '--access-key-id') ?? null
  const settings: S3ConnectionSettings = { endpoint, region, bucket: url.bucket, pathStyle, accessKeyId }

  let secret: string | null = null
  if (hasFlag(parsed, '--secret-stdin')) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    secret = Buffer.concat(chunks).toString('utf8').trim() || null
    if (!secret) return failure(output, '--secret-stdin read nothing.', EXIT.usage)
  } else if (!hasFlag(parsed, '--no-secret') && accessKeyId) {
    secret = (await readSecret(`Secret access key for ${accessKeyId}: `, 'An S3 secret access key')).trim() || null
  }

  // Prove it works before saving it, so a typo is found now rather than mid-backup.
  if (!hasFlag(parsed, '--no-check')) {
    try {
      await s3ClientFor(settings, secret, process.env, name).checkBucket()
    } catch (error) {
      return failure(output, `${(error as Error).message}\nNothing was saved. Pass --no-check to save it anyway.`, EXIT.unavailable)
    }
  }

  const display = s3DisplayFields(settings)
  const connection = await store.saveConnection({
    kind: 's3',
    s3: settings,
    name,
    host: display.host,
    port: display.port,
    username: display.username,
    authType: 'key',
    keyPath: null,
    defaultLocalPath: null,
    defaultRemotePath: url.path === '/' ? (flagValue(parsed, '--path') ?? null) : url.path,
    jumpHost: null,
    rsyncPath: null,
    connectTimeoutSeconds: 15,
    keepaliveSeconds: 30,
    forwardAgent: false,
    tags: ['s3'],
    notes: '',
  })
  await store.setConnectionSecret(connection.id, S3_SECRET_NAME, secret)

  if (output.isJson) output.json({ status: 'ok', connection })
  else {
    output.line(`Saved S3 connection ${connection.name} (s3://${settings.bucket} at ${display.host}).`)
    if (!secret) output.line('No secret stored: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY will be read at run time.')
    output.line(`Use it like a server: diskpush ./dir/ ${connection.name}:/backups/   diskpush ls ${connection.name}:/`)
  }
  return EXIT.ok
}

async function removeConnection(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const name = parsed.positionals[1]
  if (!name) return failure(output, 'Usage: diskpush connections remove NAME', EXIT.usage)
  const removed = await store.deleteConnection(name)
  if (!removed) return failure(output, `No connection named ${JSON.stringify(name)}.`, EXIT.configuration)
  if (output.isJson) output.json({ status: 'ok', removed: name })
  else output.line(`Removed connection ${name}.`)
  return EXIT.ok
}

async function importConnections(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const path = parsed.positionals[1] ?? join(homedir(), '.ssh', 'config')
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    return failure(output, `Could not read ${path}: ${(error as Error).message}`, EXIT.configuration)
  }

  const hosts = parseSshConfig(contents).filter((host) => host.hostName || host.user)
  const imported: string[] = []
  for (const host of hosts) {
    // An ssh_config alias never replaces a saved bucket of the same name (and orphans its secret).
    if ((await store.findConnection(host.alias))?.kind === 's3') continue
    await store.saveConnection({
      kind: 'ssh',
      s3: null,
      name: host.alias,
      host: host.hostName ?? host.alias,
      port: host.port ?? 22,
      username: host.user ?? process.env.USER ?? 'root',
      authType: host.identityFile ? 'key' : 'agent',
      keyPath: host.identityFile ? expandTilde(host.identityFile) : null,
      defaultLocalPath: null,
      defaultRemotePath: null,
      jumpHost: host.proxyJump ?? null,
      rsyncPath: null,
      connectTimeoutSeconds: 15,
      keepaliveSeconds: host.serverAliveInterval ?? 30,
      forwardAgent: false,
      tags: ['imported'],
      notes: `Imported from ${path}`,
    })
    imported.push(host.alias)
  }

  if (output.isJson) output.json({ status: 'ok', imported })
  else output.line(`Imported ${imported.length} host(s) from ${path}: ${imported.join(', ')}`)
  return EXIT.ok
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 22
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ArgvError(`--port must be a number between 1 and 65535, got ${JSON.stringify(value)}.`)
  }
  return port
}
