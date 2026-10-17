# Plugins

A plugin adds things DiskPush does to files: a command in the CLI, an entry
in the TUI's `a` menu and in the desktop app's right-click menu, and settings
of its own. Two ship built in: **MediaAnalyzer**, which describes photos and
videos and can sort them into folders by what they show, and **Database
backups** (`dbbackup`), which dumps Postgres, Supabase, MySQL and SQLite to
tagged, verified files, prunes them, pushes them with rsync and restores them.

```bash
diskpush plugins                                # what is installed, and its commands
diskpush plugins disable mediaanalyzer          # and back on with: enable
diskpush mediaanalyzer login                    # a plugin's own commands
diskpush mediaanalyzer analyze ~/Pictures/2024 --sort
```

| Surface | Where plugin actions are |
| --- | --- |
| CLI | `diskpush <plugin-id> <command> ...` |
| TUI | `a` on a local file or folder, then enter, the action's letter, or one click |
| Desktop | right-click a local selection → **Plugins**; settings and sign-in under the header menu → **Plugins…** |

Actions work on local files only. A pane pointed at a server has nothing on
this machine to hand a plugin; sync the files down first.

## MediaAnalyzer

[MediaAnalyzer](https://mediaanalyzer.pro) looks at each photo (and, with
ffmpeg installed, each video) and returns a description, tags and a category.
DiskPush writes those beside the file and can file it into a folder named for
the category.

```bash
diskpush mediaanalyzer login          # opens your browser; approve DiskPush
diskpush mediaanalyzer whoami         # who, how much credit, which tiers are online
diskpush mediaanalyzer analyze DIR    # describe everything under DIR
diskpush mediaanalyzer analyze DIR --sort
diskpush mediaanalyzer undo DIR       # put back what the last --sort moved
diskpush mediaanalyzer logout
```

**What it writes.** For `beach.jpg`, a `beach.jpg.description.txt`:

```text
Two children building a sandcastle at low tide.

Folder: Beach
Tags: beach, children, sandcastle
Described by MediaAnalyzer (mediaanalyzer.pro)
```

The last line is the signature. A `.description.txt` without it is yours, and
is never overwritten; one with it is, because DiskPush wrote it.

**Sorting.** *Analyze and sort into folders* (`--sort`) moves each file and
its description into `DIR/<Category>/`. Nothing is ever overwritten: a name
that is taken becomes `beach (2).jpg`. Every move is written to a journal in
`DIR/.mediaanalyzer/undo-<time>.json` before it happens, and *Undo last sort*
(`undo DIR`) walks the latest journal backwards, restoring the exact tree. A
file you have since replaced is skipped, not overwritten.

**Paying once.** Each file is identified by a hash of its relative path, size
and modification time. `DIR/.mediaanalyzer/diskpush-state.json` records the
scan and every result as it arrives, so a run that is cancelled, crashes or
loses its connection picks up where it stopped: nothing is uploaded or charged
twice. A file with a signed sidecar is treated as already described, whichever
tool wrote it.

**What is uploaded.** Photos are sent as they are, up to 30 MB each; the
server re-encodes them to 768 px and strips their metadata (EXIF, GPS) before
anything else sees them. A video is never uploaded: DiskPush sends one JPEG
contact sheet of nine frames, made locally with `ffmpeg`. Without `ffmpeg` and
`ffprobe` on `PATH`, videos are skipped and the run says so. Uploads go in
requests of at most 50 files.

**Settings** (`Plugins…` in the desktop app, or the shared settings table):

| Setting | Meaning |
| --- | --- |
| `server` | `https://mediaanalyzer.pro` unless you run your own |
| `tier` | `standard`, `premium` or `byok`. Empty: the first tier that is online, else your own provider key |
| `providerId` | which provider key `byok` uses; empty is your first |
| `folders` | comma-separated categories to sort into; empty uses the server's |
| `api_key` | an `ma_key_…` key instead of signing in (`diskpush mediaanalyzer key`) |

`DISKPUSH_MEDIAANALYZER_KEY` in the environment overrides both a sign-in and a
saved key, which is the way to run it from CI.

**Signing in.** OAuth 2.1 with PKCE, as the `diskpush` client, over a loopback
redirect to `127.0.0.1` on a random port. No password is ever typed into
DiskPush. Refresh tokens rotate: each works once, so DiskPush stores the new
one the moment it arrives and never refreshes twice at once. With no browser
on this machine (an ssh session), `login --paste` shows a URL to open anywhere
and asks for the code the page displays.

**Credit.** When the account runs out mid-run, what was accepted is still
described, the rest is left for the next run, and the result says how many
were skipped and where to add credit.

## Database backups

`dbbackup` dumps **Postgres, Supabase, MySQL/MariaDB and SQLite** to gzipped
files whose names carry the database, the time and your tags, keeps a
retention policy, pushes each backup anywhere rsync reaches, and restores
them. It is the "dump, push, prune, pull" loop people script around a bucket
tool, with the dump half built in.

```bash
diskpush dbbackup doctor                                   # which dump tools this machine has
diskpush dbbackup add shop --kind postgres --tags prod     # asks for the URL; kept with your secrets
diskpush dbbackup add app --kind supabase --url-env SUPABASE_DB_URL
diskpush dbbackup add crm --url-env CRM_MYSQL_URL --push backup@nas:/srv/db
diskpush dbbackup add notes --path ~/notes.sqlite
diskpush dbbackup run --tags nightly                       # back up everything, prune, push
diskpush dbbackup backups --tag prod --not test            # list, newest first
diskpush dbbackup verify shop                              # read the newest end to end
diskpush dbbackup restore shop --to-env STAGING_URL        # asks before it writes
diskpush dbbackup cron --at "15 3 * * *"                   # a crontab line to paste
```

### Every database on every server: `discover`

You do not have to list your databases. `discover` looks on every server
DiskPush already knows (saved connections and `~/.ssh/config` hosts, the same
list as `diskpush fleet servers`) over the ssh keys and agent you already use,
and lists what it finds; `--save` keeps them for backup.

```bash
diskpush dbbackup discover                          # look everywhere, change nothing
diskpush dbbackup discover dev2 vienna              # just these
diskpush dbbackup discover --save --tags nightly --keep-last 14 --push backup@nas:/srv/db
diskpush dbbackup run --tags nightly                # back them all up
```

On each server one read-only shell script, sent in a single ssh call, finds:

| What | How it is found | How it is backed up |
| --- | --- | --- |
| Postgres / Supabase in Docker | `docker ps` (images `postgres`, `postgis`, `supabase/postgres`, `timescale`, `pgvector`…; a compose project ending `-supabase` makes it Supabase), then each container's databases with `psql` inside it, signing in the way the image allows (`POSTGRES_USER`, `postgres`, `supabase_admin`, over the socket or `127.0.0.1`) | `docker exec <container> pg_dump …` on the server |
| MySQL / MariaDB in Docker | `docker ps`, then `mysql -uroot` inside the container with the container's own `MYSQL_ROOT_PASSWORD` | `docker exec <container> mysqldump …`, with that same password from the container's environment |
| Native Postgres | every online cluster (`pg_lsclusters`), as the `postgres` OS user | `sudo -n -u postgres pg_dump -p <port> …` |
| Native MySQL / MariaDB | root over the local socket | `mysqldump` as root |
| SQLite | files under `/srv`, `/opt`, `/var/www`, `/root`, `/home` (setting `sqliteRoots`) whose first bytes are SQLite's header, skipping dependency, cache, source-checkout and worktree folders, hidden files, `*.bak*`/replica copies and `opencode.db`; files over 4 GB are listed as skipped (`--max-sqlite-mb`) | SQLite's online backup on the server, `PRAGMA quick_check`, then the file itself comes back |

**The dump runs on the server; only its bytes come back over ssh.** No
database port is opened to this machine, no `pg_dump` of the right version is
needed here, and **no database password is copied anywhere**: a container is
entered with `docker exec`, a native install through its socket. A database
that discovery lists is one that it reached exactly the way the backup will.
The same completion-line rule applies, so a dump cut short by a dropped
connection is still thrown away.

Each database is named after its server and what a person would call it
(`dev2-crawlproof`, `dev2-nichedb-supabase`, `bbs-agentbbs-bbs`), and app
env files (`~/www/*/app.env`, `*/.env`) that point at it are shown beside it,
passwords masked on the server before they are read. Running `discover` again
adds only what is new, and names anything saved that a reachable server no
longer has.

Git forges (`github.com`, `gitlab.com`, …) and second aliases of the same
`user@host:port` are not looked on, and two aliases that turn out to reach the
same machine (same `/etc/machine-id`) are listed once, under the one with the
most access. A server that cannot be reached is reported and the rest carry on.
Probing uses `ssh -o BatchMode=yes`: an unknown host key fails rather than
asks, unless you pass `--accept-new`. The login needs to be root, in the
`docker` group, or have passwordless `sudo` for what it should see; the report
says when it cannot get in somewhere. In the desktop, *Find databases on every
server* under Plugins… does the same and saves what it finds.

**File names are the catalogue.** `shop--20261017T031500Z--nightly+prod.sql.gz`
is database `shop`, taken at that UTC time, tagged `nightly` and `prod`. Each
database gets its own folder under the backup folder (`~/Backups/diskpush`
unless the `backupDir` setting says otherwise), so a plain directory listing,
local or on a server, is the whole index and nothing can drift out of step.
`backups` filters with `--tag` (all of), `--any` (one of) and `--not`.

| Kind | Made with | Notes |
| --- | --- | --- |
| `postgres` | `pg_dump --format=plain` | owners and privileges kept. The newest `pg_dump` installed is used (`/usr/lib/postgresql/<n>/bin` is searched), because `pg_dump` refuses a server newer than itself |
| `supabase` | `pg_dump --no-owner --no-privileges` | Supabase's platform schemas (`realtime`, `vault`, `pgsodium`, `graphql`, `supabase_functions`, `extensions`, …) are left out; `auth`, `storage`, `public` and your own schemas are in. Use the **session pooler** or direct connection string from the dashboard's Connect panel, not the transaction pooler |
| `mysql` | `mysqldump` or `mariadb-dump` | `--single-transaction --routines --triggers --events --hex-blob`, one database, no `CREATE DATABASE`, so it restores into a database of any name. `?ssl-mode=REQUIRED` on the URL becomes `--ssl-mode=REQUIRED` |
| `sqlite` | SQLite's online backup | `node:sqlite` where Node has it, else `sqlite3 .backup`; never a file copy, so a live WAL database is copied consistently. The copy must pass `PRAGMA quick_check` |

**A backup that exists is a whole one.** The dump streams through gzip into a
hidden `.partial` file and is renamed into place only if the tool exited 0 and
the stream ended with the tool's own completion line (`-- PostgreSQL database
dump complete`, `-- Dump completed`). A dump cut short by a dropped connection
or a full disk is discarded and the run fails. `verify` checks the same thing
later, and `restore` verifies before it touches anything.

**Passwords stay out of argv.** URLs are asked for at the prompt rather than
taken from the command line, stored with the plugin's secrets (not its
settings), shown redacted, and handed to the tools as `PGPASSWORD` /
`MYSQL_PWD`. `--url-env VAR` stores nothing: the URL is read from the
environment on every run, which is the way to keep it in a vault.

**Retention.** Each database and tag set is its own series, so a `monthly` run
never prunes `nightly` backups. A series keeps its newest `keepLast` (default
7), plus anything younger than `keepDays` (default off), and **always keeps its
newest backup**, whatever the policy says. Set them per database with
`add --keep-last 14 --keep-days 30d`, or globally in settings. `prune
--dry-run` shows what would go. Files the plugin did not name are never
touched.

**Pushing.** With `--push DEST` (or the global `push` setting) every run
copies the database's folder to `DEST/<name>/` with
`rsync --archive --partial --mkpath --delete`, over `ssh -o BatchMode=yes` so a
cron job never hangs on a prompt. `--delete` makes the destination follow
local pruning, and a protect filter limits it to files named `<name>--*`: a
mistyped destination can only ever lose backups this plugin made. `DEST` is
anything rsync takes: `user@host:/path`, a mounted disk, a NAS.

**Restoring.** SQL dumps go through `psql` (with `ON_ERROR_STOP=1`; pass
`--continue-on-error` to load what it can) or `mysql`, into the URL in
`--to-env VAR` (or `--to URL`). A SQLite backup is written to `--to PATH`
through a temporary name, and refuses to replace an existing file without
`--force`. Without `--yes` it asks first. Restoring into an existing database
does not drop it first; restore into a fresh one.

**From the file browser.** In the TUI (`a`) and the desktop (right-click →
Plugins): *Back up SQLite database* on a `.sqlite`/`.db` file (refused unless
the file really is SQLite), and *Verify backup* on a backup. *Back up every
database now* is under Plugins… in the desktop.

**Settings:** `backupDir`, `keepLast`, `keepDays`, `push`, `rsh` (the ssh
command for pushes), `sqliteRoots` (where discovery looks for SQLite files), and `pg_dumpPath` / `mysqldumpPath` / `psqlPath` /
`mysqlPath` / `sqlite3Path` to pin a tool.

## Writing a plugin

A plugin is an object. `definePlugin` checks its shape when it is defined, so
a bad id fails your tests rather than someone's menu.

```ts
import { definePlugin } from '@diskpush/plugin-api'

export default definePlugin({
  id: 'checksums',                 // also the CLI command: diskpush checksums ...
  name: 'Checksums',
  version: '1.0.0',
  description: 'Write a SHA-256 beside each file.',
  actions: [
    {
      id: 'sha256',
      label: 'Write SHA-256 sums',
      tuiKey: 's',                 // a hint; dropped if it clashes
      appliesTo: (entries) => entries.some((entry) => !entry.isDirectory),
      async run(ctx) {
        ctx.progress.start(ctx.entries.length)
        let done = 0
        for (const entry of ctx.entries) {
          ctx.signal.throwIfAborted()
          // ... hash join(ctx.dir, entry.name) ...
          ctx.progress.update({ done: ++done, currentFile: entry.name })
        }
        return { ok: true, message: `Wrote ${done} sums.`, changed: true }
      },
    },
  ],
  commands: [
    {
      name: 'verify',
      summary: 'check every sum under DIR',
      usage: 'verify DIR',
      async run(args, ctx) {
        ctx.print(`verifying ${args[0]}`)
        return 0                   // the exit code
      },
    },
  ],
  settings: [{ key: 'algorithm', label: 'Algorithm', type: 'enum', options: ['sha256', 'sha512'], default: 'sha256' }],
})
```

### The context

Every action, command and task gets one context object, whichever surface runs
it (`ctx.surface` says which: `cli`, `tui` or `desktop`).

| Member | What it is |
| --- | --- |
| `dir`, `names`, `entries` | actions only: the absolute local directory, and the selected entries in it as bare names (never paths), each with `isDirectory` and `size` |
| `settings.get(key, fallback)` / `settings.set(key, value)` | your settings, stored as `plugin:<id>:<key>` in the table the CLI and the desktop share |
| `secrets.get(key)` / `secrets.set(key, value \| null)` | tokens and keys, stored apart from settings and never sent to the desktop renderer |
| `progress.start(total?)`, `progress.update({done, total, message, currentFile})`, `progress.log(level, message)` | the CLI's status line, the TUI's job panel, the desktop's transfer band |
| `openUrl(url)` | the user's browser; http and https only |
| `signal` | aborted on Ctrl+C, esc, or Cancel. Stop, save what you have, return |
| `env` | environment variables |
| `servers` | optional: the user's servers (`list()` → name, host, port, username, keyPath, jumpHost, sshConfigAlias, passwordAuth; never a password), plus `knownHostsFiles` and `sshConfigFile` to hand to `ssh`. Absent where a host has none to offer |
| `print`, `warn`, `printJson`, `json`, `prompt`, `cwd` | commands only |

An action returns `{ ok, message, changed? }`. `changed: true` makes the file
browser read the directory again. A thrown error becomes a failed result with
its message; it never takes the host down.

`appliesTo(entries, { dir })` runs as a menu opens, so it must be cheap and
synchronous. `tasks` are actions that take no files (signing in); the desktop
draws them as buttons in the plugin's settings.

### Installing one

```bash
diskpush plugins add some-diskpush-plugin     # from npm
diskpush plugins remove <plugin-id>
```

External plugins live in their own small npm project,
`~/.config/diskpush/plugins/` (or `$DISKPUSH_HOME/plugins/`). A package is
loaded only if it is listed in that directory's `package.json` and its own
`package.json` has a `"diskpush"` field, e.g. `"diskpush": { "apiVersion": 1 }`.
Its default export (or `export const plugin`) is the plugin. `add` needs `npm`
on `PATH`, and installs with `--ignore-scripts`. The desktop app loads the same
directory at start.

A plugin written against another major version of the API
(`PLUGIN_API_VERSION`, currently 1) is refused with a message rather than
loaded and left to fail.

## Security model

**A plugin runs with your privileges.** It is JavaScript in the CLI process,
or in the desktop app's *main* process, and it can do anything you can: read
and change any file, open network connections, run programs. Nothing sandboxes
it. Adding a plugin is the same decision as installing a program, and
`diskpush plugins add` says so before it installs anything.

What DiskPush does guarantee:

- **Never in the renderer.** The desktop renderer is treated as untrusted
  input everywhere, and plugins do not change that. It names a plugin and an
  action by id and the files as an absolute local directory plus bare entry
  names (the same `EntryNameSchema` every file operation uses), all validated
  by Zod in the main process. It cannot hand a plugin `../`, a path of its own,
  or a server path, and there is still no generic `invoke`: the preload exposes
  named plugin methods only.
- **Secrets stay out of the renderer.** A plugin's secret settings can be set
  from the desktop's settings dialog but are never sent back to it; the dialog
  only learns whether one is set.
- **Symlinks are not followed** when a selection is described or walked, so an
  action on a folder cannot be led outside it.
- **Only declared settings** can be written from the desktop, each checked
  against its declared type.
- **Loading is explicit.** Only packages listed in the plugins `package.json`
  and marked as DiskPush plugins load; one that fails is reported and skipped.
- **The store is owner-only.** Sign-ins are kept in the local database's
  settings table, and DiskPush sets that file to mode `0600` when it opens it.
  They are not yet in the OS keychain; see below.

Built-in plugins ship inside DiskPush and are reviewed with it.

### Not yet

- Secrets in the OS keychain (Electron `safeStorage`, `libsecret`). The hook is
  there (`SecretCodec` in `@diskpush/plugin-api`), but encrypting with the
  desktop's keychain would lock the CLI out of the same sign-in, so it waits
  for a keychain both can reach.
- Plugin actions on remote panes.
- Adding plugins from the desktop app (it has no `npm`).
