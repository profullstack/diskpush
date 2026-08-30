# CLI

## Grammar

```text
diskpush [command] SOURCE DESTINATION [diskpush options] -- [rsync args]
```

Everything before a standalone `--` belongs to DiskPush. Everything after it is
handed to rsync as verbatim argument tokens, in order, with no reinterpretation
and no shell involved.

The bare two-endpoint form is an alias for `sync`:

```bash
diskpush ./dist/ prod:/srv/app/     # same as: diskpush sync ./dist/ prod:/srv/app/
```

## Endpoints

| Form | Meaning |
| --- | --- |
| `./dist/`, `/var/www`, `~/media` | a local path |
| `prod:/srv/app/` | a saved connection named `prod`, or an `~/.ssh/config` alias |
| `deploy@example.com:/var/www/` | an explicit user and host |
| `prod:` | the remote user's home directory |

The trailing slash means what it means in rsync: `src/` copies the *contents*
of src; `src` copies the directory itself into the destination. DiskPush
preserves exactly what you typed.

A saved connection contributes its username, port, key, jump host and remote
rsync path. An unrecognised name is passed through to SSH, so anything already
in `~/.ssh/config` works without being imported first.

## Commands

### Transfers

```bash
diskpush sync SRC DST       # bring the destination up to date
diskpush push SRC DST       # same engine, upload-shaped intent
diskpush pull SRC DST       # same engine, download-shaped intent
diskpush publish SRC DST    # same engine, deploy-shaped intent
diskpush backup SRC DST     # same engine, backup-shaped intent
diskpush mirror SRC DST     # sync AND delete destination-only files
diskpush rsync SRC DST -- ARGS   # endpoint resolution and orchestration only
```

All three topologies work with the same grammar:

```bash
diskpush ./dist/ prod:/srv/app/               # local  -> server
diskpush prod:/var/log/ ./logs/               # server -> local
diskpush media-01:/srv/media/ backup-02:/data/ # server -> server, directly
```

### Browsing

```bash
diskpush ls                      # the current directory
diskpush ls prod:/srv/app        # a remote directory, over SFTP

diskpush tui                     # two-pane browser, local beside cwd
diskpush tui prod:/srv/app       # local beside a server
diskpush tui ./dist prod:/srv/   # both sides named

diskpush desktop                 # launch the desktop app
```

In the TUI: `tab` switches pane, arrows or `j`/`k` move, Enter or `l` opens,
`h` or left goes up, **`c` points the active pane somewhere else**, `s` syncs
the active pane into the other, `p` previews that sync, `r` refreshes, `q`
quits.

`c` opens a picker listing Local, your saved connections, and the hosts in
`~/.ssh/config` — so either pane can be a server without naming one on the
command line, and `diskpush tui` on its own is a useful starting point rather
than two local directories. It deliberately offers no Mirror — deleting files from a keystroke,
with no delete list on screen, is the accident the rest of DiskPush exists to
prevent. Use `diskpush mirror`.

A remote pane resolves against your saved connections first and then
`~/.ssh/config`, so hosts you already have work without being imported.

### Connections

```bash
diskpush connections                                   # list
diskpush connections add NAME [user@]host [--port N] [--identity PATH]
diskpush connections test NAME                         # SSH, SFTP, remote rsync
diskpush connections import [~/.ssh/config]            # import existing hosts
diskpush connections remove NAME
```

`connections test` also caches the remote's rsync capabilities, so later
transfers can gate options such as `--compress-choice=zstd` and `--mkpath` on
what that server actually supports rather than on what the local rsync does.

### Profiles

```bash
diskpush profiles                              # list
diskpush profiles save NAME SRC DST [options]
diskpush profiles show NAME
diskpush profile run NAME
diskpush profiles remove NAME
```

Profiles and connections live in the same local database as the desktop app.
Something saved in one is immediately usable from the other.

### Jobs

```bash
diskpush jobs [--limit N] [--state STATE]
diskpush job ID
diskpush retry ID
```

`retry` re-runs a recorded job from its stored endpoints and options. Nothing
special happens: rsync's partial file is what makes it a resume rather than a
restart, so retrying is running the same job again.

There is no `diskpush cancel`. A CLI transfer runs in the foreground, where
Ctrl+C stops it and leaves the partial data intact; cancelling someone else's
job would need a background daemon, which does not exist yet.

## Options

| Option | Effect |
| --- | --- |
| `-n`, `--dry-run` | Show the change set; transfer nothing. |
| `--print-args` | Print the exact rsync command and exit. |
| `--preset NAME` | `fast-sync`, `exact-mirror`, `maximum-metadata`, `slow-wan`, `verify-everything`. |
| `-p`, `--profile NAME` | Use a saved profile's options. |
| `-e`, `--exclude GLOB` | Exclude a pattern. Repeatable. |
| `--exclude-preset NAME` | `node`, `git`, `macos`, `python`, `editor`. Repeatable. |
| `--include GLOB` | Include a pattern. Applied before excludes. |
| `--checksum` | Compare by content hash instead of size and time. |
| `--compress[=ALGO]` | `zstd` (default), `zlib`. Bare `--compress` means zstd. |
| `--bwlimit RATE` | e.g. `50M`. |
| `--max-size`, `--min-size` | Size filters. |
| `--hard-links`, `--acls`, `--xattrs`, `--numeric-ids`, `--sparse` | Extra metadata. |
| `--update`, `--ignore-existing`, `--existing` | Destination policies. |
| `--inplace`, `--append-verify`, `--mkpath` | Advanced. |
| `--progress` | rsync's own per-file progress, instead of the aggregate line DiskPush draws. |
| `--stats` | Include rsync's transfer statistics. |
| `-y`, `--yes` | Confirm a mirror's deletions without prompting. |
| `--non-interactive` | Never prompt; fail instead. |
| `--json` | Machine-readable result on stdout. |
| `-q`, `--quiet` | Suppress normal output. |
| `--no-progress` | Do not draw a progress line. |

`--compress` takes its value only in the `--compress=zlib` form. As a bare
flag it is a boolean, so that `diskpush sync --compress ./a/ ./b/` cannot
mistake an endpoint for its value.

## Pass-through

```bash
diskpush sync ./app/ prod:/var/www/app/ -- --archive --partial
diskpush push ./videos/ media:/srv/videos/ -- -a --partial --bwlimit=50M
diskpush sync a:/data/ b:/backup/ -- -aHAX --info=progress2
```

Tokens after `--` are preserved exactly, including spaces, quotes and
metacharacters, and are appended after the generated flags so that rsync's
last-wins behaviour gives them precedence.

Two families are refused rather than passed through:

- `--delete`, `--delete-during`, `--delete-delay`, `--delete-after`,
  `--delete-excluded`, `--del`, `--delete-before`, `--delete-missing-args`.
  These would delete destination files behind the preview that exists to show
  you exactly that. Use `diskpush mirror`.
- `--remove-source-files`, `--remove-sent-files`. These delete the *source*.
  DiskPush copies; it does not move.

A confirmed mirror waives the first group, because you have just been shown
exactly what it would delete. It waives nothing else: confirming a
*destination* delete list says nothing about deleting the source, so
`--remove-source-files` stays refused either way.

`-e`, `--rsh`, `--rsync-path`, `--daemon`, `--config` and `--password-file`
produce a warning, because they replace transport DiskPush configured from the
connection.

For a server-to-server job the same pass-through tokens are applied to the
rsync process launched on the source host.

## Precedence

```text
built-in safe defaults
        ↓
selected preset or profile
        ↓
structured DiskPush flags
        ↓
raw arguments after --
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1`–`35` | rsync's own exit code, passed through unchanged. |
| `64` | Bad command line. |
| `65` | Unknown connection, profile or path. |
| `66` | DiskPush declined: unconfirmed mirror, or a blocked pass-through argument. |
| `69` | Precondition failed: rsync missing, host unreachable. |
| `70` | Internal error. |

Codes 24 (some source files vanished) and 0 are both treated as success. Codes
10, 11, 12, 20, 23, 30 and 35 are reported as **resumable**: the job stopped,
the partial data is intact, and re-running it continues.

`--json` reports both layers:

```json
{
  "status": "failed",
  "diskpushExitCode": 0,
  "rsyncExitCode": 23,
  "resumable": true,
  "message": "Partial transfer due to error. Some files could not be transferred; the rest arrived."
}
```

## Automation

- Structured results on stdout, diagnostics on stderr.
- `--non-interactive` guarantees no prompt; a mirror that would delete
  something exits `66` instead of waiting.
- Progress is only drawn when stdout is a TTY, so cron and CI logs stay clean.
