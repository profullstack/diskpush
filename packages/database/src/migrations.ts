/**
 * Migrations are applied in order at open time and recorded by name, so a
 * DiskPush that starts against an older database upgrades it in place.
 *
 * Credentials are deliberately absent from every table here. Passwords and
 * key passphrases live in OS-backed secure storage; this file holds only the
 * data that would be safe in a backup.
 */
export type Migration = { name: string; statements: string[] }

export const MIGRATIONS: Migration[] = [
  {
    name: '001-initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'agent',
        key_path TEXT,
        default_local_path TEXT,
        default_remote_path TEXT,
        jump_host TEXT,
        rsync_path TEXT,
        connect_timeout_seconds INTEGER NOT NULL DEFAULT 15,
        keepalive_seconds INTEGER,
        forward_agent INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sync_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        source_json TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        preset TEXT NOT NULL DEFAULT 'fast-sync',
        options_json TEXT NOT NULL,
        trust_deletes INTEGER NOT NULL DEFAULT 0,
        schedule_json TEXT NOT NULL DEFAULT '{}',
        watch_json TEXT NOT NULL DEFAULT '{}',
        notify_on_success INTEGER NOT NULL DEFAULT 0,
        notify_on_failure INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS transfer_jobs (
        id TEXT PRIMARY KEY,
        profile_id TEXT REFERENCES sync_profiles(id) ON DELETE SET NULL,
        source_json TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        options_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        bytes_total INTEGER NOT NULL DEFAULT 0,
        bytes_transferred INTEGER NOT NULL DEFAULT 0,
        percent REAL NOT NULL DEFAULT 0,
        files_transferred INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        error_summary TEXT,
        log_path TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS transfer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        data_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_state ON transfer_jobs(state, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_job ON transfer_events(job_id, id)`,
    ],
  },
]
