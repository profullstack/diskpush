import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient, type Client, type InValue } from '@libsql/client'
import {
  ConnectionSchema,
  SyncProfileSchema,
  TransferJobSchema,
  type Connection,
  type JobState,
  type SyncProfile,
  type TransferJob,
} from '@diskpush/schemas'
import { MIGRATIONS } from './migrations.js'
import { databasePath } from './paths.js'

export type StoreOptions = { path?: string; env?: NodeJS.ProcessEnv }

/**
 * The single local store behind both the desktop app and the CLI.
 *
 * There is intentionally no second configuration universe: a profile created
 * in one surface is immediately runnable from the other.
 */
export class DiskPushStore {
  private constructor(private readonly client: Client, readonly path: string) {}

  static async open(options: StoreOptions = {}): Promise<DiskPushStore> {
    const path = options.path ?? databasePath(options.env)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const client = createClient({ url: path === ':memory:' ? ':memory:' : `file:${path}` })
    const store = new DiskPushStore(client, path)
    await store.migrate()
    return store
  }

  private async migrate(): Promise<void> {
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
    )
    const applied = await this.client.execute('SELECT name FROM schema_migrations')
    const done = new Set(applied.rows.map((row) => String(row.name)))

    for (const migration of MIGRATIONS) {
      if (done.has(migration.name)) continue
      for (const statement of migration.statements) await this.client.execute(statement)
      await this.client.execute({
        sql: 'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
        args: [migration.name, new Date().toISOString()],
      })
    }
  }

  async close(): Promise<void> {
    this.client.close()
  }

  // --- connections ---------------------------------------------------------

  async listConnections(): Promise<Connection[]> {
    const result = await this.client.execute('SELECT * FROM connections ORDER BY name')
    return result.rows.map(rowToConnection)
  }

  async findConnection(nameOrId: string): Promise<Connection | null> {
    const result = await this.client.execute({
      sql: 'SELECT * FROM connections WHERE name = ? OR id = ? LIMIT 1',
      args: [nameOrId, nameOrId],
    })
    const row = result.rows[0]
    return row ? rowToConnection(row) : null
  }

  async saveConnection(input: Omit<Connection, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Connection> {
    const now = new Date().toISOString()
    const existing = input.id ? await this.findConnection(input.id) : await this.findConnection(input.name)
    const connection = ConnectionSchema.parse({
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    await this.client.execute({
      sql: `INSERT INTO connections (
              id, name, host, port, username, auth_type, key_path,
              default_local_path, default_remote_path, jump_host, rsync_path,
              connect_timeout_seconds, keepalive_seconds, forward_agent, tags, notes,
              created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, host=excluded.host, port=excluded.port,
              username=excluded.username, auth_type=excluded.auth_type, key_path=excluded.key_path,
              default_local_path=excluded.default_local_path, default_remote_path=excluded.default_remote_path,
              jump_host=excluded.jump_host, rsync_path=excluded.rsync_path,
              connect_timeout_seconds=excluded.connect_timeout_seconds,
              keepalive_seconds=excluded.keepalive_seconds, forward_agent=excluded.forward_agent,
              tags=excluded.tags, notes=excluded.notes, updated_at=excluded.updated_at`,
      args: [
        connection.id,
        connection.name,
        connection.host,
        connection.port,
        connection.username,
        connection.authType,
        connection.keyPath,
        connection.defaultLocalPath,
        connection.defaultRemotePath,
        connection.jumpHost,
        connection.rsyncPath,
        connection.connectTimeoutSeconds,
        connection.keepaliveSeconds,
        connection.forwardAgent ? 1 : 0,
        JSON.stringify(connection.tags),
        connection.notes,
        connection.createdAt,
        connection.updatedAt,
      ],
    })
    return connection
  }

  async deleteConnection(nameOrId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'DELETE FROM connections WHERE name = ? OR id = ?',
      args: [nameOrId, nameOrId],
    })
    return result.rowsAffected > 0
  }

  // --- profiles ------------------------------------------------------------

  async listProfiles(): Promise<SyncProfile[]> {
    const result = await this.client.execute('SELECT * FROM sync_profiles ORDER BY name')
    return result.rows.map(rowToProfile)
  }

  async findProfile(nameOrId: string): Promise<SyncProfile | null> {
    const result = await this.client.execute({
      sql: 'SELECT * FROM sync_profiles WHERE name = ? OR id = ? LIMIT 1',
      args: [nameOrId, nameOrId],
    })
    const row = result.rows[0]
    return row ? rowToProfile(row) : null
  }

  async saveProfile(input: Omit<SyncProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SyncProfile> {
    const now = new Date().toISOString()
    const existing = input.id ? await this.findProfile(input.id) : await this.findProfile(input.name)
    const profile = SyncProfileSchema.parse({
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    await this.client.execute({
      sql: `INSERT INTO sync_profiles (
              id, name, source_json, destination_json, preset, options_json, trust_deletes,
              schedule_json, watch_json, notify_on_success, notify_on_failure, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, source_json=excluded.source_json,
              destination_json=excluded.destination_json, preset=excluded.preset,
              options_json=excluded.options_json, trust_deletes=excluded.trust_deletes,
              schedule_json=excluded.schedule_json, watch_json=excluded.watch_json,
              notify_on_success=excluded.notify_on_success, notify_on_failure=excluded.notify_on_failure,
              updated_at=excluded.updated_at`,
      args: [
        profile.id,
        profile.name,
        JSON.stringify(profile.source),
        JSON.stringify(profile.destination),
        profile.preset,
        JSON.stringify(profile.options),
        profile.trustDeletes ? 1 : 0,
        JSON.stringify(profile.schedule),
        JSON.stringify(profile.watch),
        profile.notifyOnSuccess ? 1 : 0,
        profile.notifyOnFailure ? 1 : 0,
        profile.createdAt,
        profile.updatedAt,
      ],
    })
    return profile
  }

  async deleteProfile(nameOrId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: 'DELETE FROM sync_profiles WHERE name = ? OR id = ?',
      args: [nameOrId, nameOrId],
    })
    return result.rowsAffected > 0
  }

  // --- jobs ----------------------------------------------------------------

  async createJob(job: Omit<TransferJob, 'createdAt'> & { createdAt?: string }): Promise<TransferJob> {
    const parsed = TransferJobSchema.parse({ ...job, createdAt: job.createdAt ?? new Date().toISOString() })
    await this.client.execute({
      sql: `INSERT INTO transfer_jobs (
              id, profile_id, source_json, destination_json, options_json, state,
              bytes_total, bytes_transferred, percent, files_transferred, retry_count,
              exit_code, error_summary, log_path, created_at, started_at, completed_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        parsed.id,
        parsed.profileId,
        JSON.stringify(parsed.source),
        JSON.stringify(parsed.destination),
        JSON.stringify(parsed.options),
        parsed.state,
        parsed.bytesTotal,
        parsed.bytesTransferred,
        parsed.percent,
        parsed.filesTransferred,
        parsed.retryCount,
        parsed.exitCode,
        parsed.errorSummary,
        parsed.logPath,
        parsed.createdAt,
        parsed.startedAt,
        parsed.completedAt,
      ],
    })
    return parsed
  }

  async updateJob(id: string, patch: Partial<TransferJob>): Promise<void> {
    const columns: Record<keyof TransferJob & string, string> = {
      state: 'state',
      bytesTotal: 'bytes_total',
      bytesTransferred: 'bytes_transferred',
      percent: 'percent',
      filesTransferred: 'files_transferred',
      retryCount: 'retry_count',
      exitCode: 'exit_code',
      errorSummary: 'error_summary',
      logPath: 'log_path',
      startedAt: 'started_at',
      completedAt: 'completed_at',
    } as never

    const sets: string[] = []
    const args: InValue[] = []
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      args.push(value as InValue)
    }
    if (sets.length === 0) return
    args.push(id)
    await this.client.execute({ sql: `UPDATE transfer_jobs SET ${sets.join(', ')} WHERE id = ?`, args })
  }

  async listJobs(limit = 50, state?: JobState): Promise<TransferJob[]> {
    const result = state
      ? await this.client.execute({
          sql: 'SELECT * FROM transfer_jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?',
          args: [state, limit],
        })
      : await this.client.execute({
          sql: 'SELECT * FROM transfer_jobs ORDER BY created_at DESC LIMIT ?',
          args: [limit],
        })
    return result.rows.map(rowToJob)
  }

  async findJob(id: string): Promise<TransferJob | null> {
    const result = await this.client.execute({ sql: 'SELECT * FROM transfer_jobs WHERE id = ?', args: [id] })
    const row = result.rows[0]
    return row ? rowToJob(row) : null
  }

  async appendEvent(jobId: string, type: string, message: string | null, data?: unknown): Promise<void> {
    await this.client.execute({
      sql: 'INSERT INTO transfer_events (job_id, timestamp, type, message, data_json) VALUES (?,?,?,?,?)',
      args: [jobId, new Date().toISOString(), type, message, data === undefined ? null : JSON.stringify(data)],
    })
  }

  // --- settings ------------------------------------------------------------

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const result = await this.client.execute({ sql: 'SELECT value_json FROM settings WHERE key = ?', args: [key] })
    const row = result.rows[0]
    if (!row) return fallback
    return JSON.parse(String(row.value_json)) as T
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      args: [key, JSON.stringify(value), new Date().toISOString()],
    })
  }
}

type Row = Record<string, unknown>

function rowToConnection(row: Row): Connection {
  return ConnectionSchema.parse({
    id: String(row.id),
    name: String(row.name),
    host: String(row.host),
    port: Number(row.port),
    username: String(row.username),
    authType: String(row.auth_type),
    keyPath: row.key_path === null ? null : String(row.key_path),
    defaultLocalPath: row.default_local_path === null ? null : String(row.default_local_path),
    defaultRemotePath: row.default_remote_path === null ? null : String(row.default_remote_path),
    jumpHost: row.jump_host === null ? null : String(row.jump_host),
    rsyncPath: row.rsync_path === null ? null : String(row.rsync_path),
    connectTimeoutSeconds: Number(row.connect_timeout_seconds),
    keepaliveSeconds: row.keepalive_seconds === null ? null : Number(row.keepalive_seconds),
    forwardAgent: Number(row.forward_agent) === 1,
    tags: JSON.parse(String(row.tags)),
    notes: String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })
}

function rowToProfile(row: Row): SyncProfile {
  return SyncProfileSchema.parse({
    id: String(row.id),
    name: String(row.name),
    source: JSON.parse(String(row.source_json)),
    destination: JSON.parse(String(row.destination_json)),
    preset: String(row.preset),
    options: JSON.parse(String(row.options_json)),
    trustDeletes: Number(row.trust_deletes) === 1,
    schedule: JSON.parse(String(row.schedule_json)),
    watch: JSON.parse(String(row.watch_json)),
    notifyOnSuccess: Number(row.notify_on_success) === 1,
    notifyOnFailure: Number(row.notify_on_failure) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })
}

function rowToJob(row: Row): TransferJob {
  return TransferJobSchema.parse({
    id: String(row.id),
    profileId: row.profile_id === null ? null : String(row.profile_id),
    source: JSON.parse(String(row.source_json)),
    destination: JSON.parse(String(row.destination_json)),
    options: JSON.parse(String(row.options_json)),
    state: String(row.state),
    bytesTotal: Number(row.bytes_total),
    bytesTransferred: Number(row.bytes_transferred),
    percent: Number(row.percent),
    filesTransferred: Number(row.files_transferred),
    retryCount: Number(row.retry_count),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    errorSummary: row.error_summary === null ? null : String(row.error_summary),
    logPath: row.log_path === null ? null : String(row.log_path),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  })
}
