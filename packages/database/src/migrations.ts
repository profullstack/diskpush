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
  {
    name: '002-fleet',
    statements: [
      `CREATE TABLE IF NOT EXISTS fleet_commands (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        script TEXT NOT NULL,
        interpreter TEXT NOT NULL DEFAULT 'sh',
        sudo INTEGER NOT NULL DEFAULT 0,
        working_directory TEXT,
        timeout_seconds INTEGER NOT NULL DEFAULT 900,
        targets TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      /*
       * A run records the script it ran, not just a reference to the command
       * it came from: editing a saved command must not silently rewrite the
       * history of what was executed on production last Tuesday.
       */
      `CREATE TABLE IF NOT EXISTS fleet_runs (
        id TEXT PRIMARY KEY,
        command_id TEXT REFERENCES fleet_commands(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        script TEXT NOT NULL,
        interpreter TEXT NOT NULL DEFAULT 'sh',
        sudo INTEGER NOT NULL DEFAULT 0,
        working_directory TEXT,
        timeout_seconds INTEGER NOT NULL DEFAULT 900,
        concurrency INTEGER NOT NULL DEFAULT 4,
        on_failure TEXT NOT NULL DEFAULT 'continue',
        target_selector TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'running',
        hosts_total INTEGER NOT NULL DEFAULT 0,
        hosts_succeeded INTEGER NOT NULL DEFAULT 0,
        hosts_failed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      /*
       * connection_name and host are denormalised copies. A run has to stay
       * readable after the connection it names is renamed or deleted, and a
       * post-mortem that says "the host that used to be id 7f3a" is not one.
       */
      `CREATE TABLE IF NOT EXISTS fleet_run_hosts (
        run_id TEXT NOT NULL REFERENCES fleet_runs(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        host TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        exit_code INTEGER,
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '',
        error_summary TEXT,
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER,
        PRIMARY KEY (run_id, connection_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_fleet_runs_created ON fleet_runs(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_fleet_run_hosts_state ON fleet_run_hosts(run_id, state)`,
    ],
  },
]
