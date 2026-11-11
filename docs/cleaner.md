# Cleaner

The Cleaner frees disk space intelligently, on this machine or on any server
DiskPush can reach over ssh. It is a built-in plugin, on by default; turn it
off with `diskpush plugins disable cleaner` or under Plugins… in the desktop
app.

It works in two steps, and the first one is the point:

1. **Analysis (always a dry run).** What is using the disk and what is
   growing it: every filesystem's free space, the biggest directories, which
   processes are writing to disk right now, and how much each filesystem and
   directory grew since the last analysis. Every finding is classified and
   explained, then ranked by bytes freed per unit of risk into a plan.
2. **Apply (only when you say so).** Removes the items you chose, but only
   items in the safe classes, and only after checking every guard again on
   the target at the moment of deleting.

```bash
diskpush clean report                       # this machine: analysis only
diskpush clean report web-1                 # a server from `diskpush fleet servers`
diskpush clean                              # dry run: exactly what would be removed
diskpush clean --apply                      # remove it
diskpush clean web-1 --only docker,caches --apply
diskpush clean --min-free-gb 20 --apply     # do nothing while 20 GB are free; stop once they are
diskpush clean cron --min-free-gb 20        # a crontab line for that, every 15 minutes
diskpush clean report --json                # the whole report, for scripts
```

`clean` is short for `cleaner`; `diskpush clean [TARGET]` with no command is
`diskpush clean run [TARGET]`.

## The three classes

| Class | What | Removed? |
| --- | --- | --- |
| **safe** | Regenerable: package-manager caches, docker build cache, unused docker images older than 72 h, the systemd journal above a size cap, rotated logs (compressed, not deleted). The only cost is time: the next install or build fetches or rebuilds it. | On apply |
| **safe-if-idle** | Build output in projects nobody is using, and partial downloads whatever was writing them has abandoned. Removable only because the guards prove it. | On apply |
| **needs a human** | Database data, backups, docker volumes, stopped containers, media and downloads. | **Never.** Reported with a command to look closer. |

Each item in a report carries its class, its estimated size, the reason it is
or is not safe, and a suggested command.

## Categories

Choose with `--only` (CLI), `only` (MCP) or the checkboxes (desktop).

- **caches**: npm (`npm cache clean --force`), pnpm (`pnpm store prune`,
  which only removes packages no project references), yarn, bun, uv, pip,
  the cargo registry's downloads and unpacked sources, and the go build
  cache. A cache is skipped while its tool is running.
- **docker**: `docker builder prune -f` (build cache no build is using) and
  `docker image prune -a -f --filter until=72h` (images no container uses,
  older than the age, so a recent deploy can still roll back; change it with
  `--image-age`). Docker volumes and containers are never touched.
- **logs**: `journalctl --vacuum-size=1G` (`--journal-cap`) and gzip of
  rotated, uncompressed logs over 1 MB in `/var/log` that no process has open.
  Both usually need root: run as root, or pass `--sudo` to let these steps
  use passwordless `sudo -n` where it works. Without either they are listed
  with the command to run by hand.
- **build**: `node_modules`, `.next`, `.nuxt`, `.turbo`, `.svelte-kit`,
  `.parcel-cache`, `.output`, `target`, `dist`, `build`, under the project
  folders (default `~/src`, `~/code`, `~/projects`, `~/dev`, `~/work`,
  `~/repos`, `~/git`, `~/worktrees`, `~/scratch`, `~/Developer`; set
  `--roots` or the *Project folders* setting).
- **partials**: `*.partial`, `*.part` and `*.crdownload` files under your home
  folder (or the *Partial-file folders* setting).

## The guards

Build output is removed only when **all** of these hold, at scan time and
again at delete time:

- it is really build output: `node_modules` and friends sit next to a
  `package.json`; `target` next to a `Cargo.toml` or holds a `CACHEDIR.TAG`;
  it is not a symlink;
- git ignores it. `dist`, `build` and `.output` outside a git repository are
  kept, because nothing proves they are generated;
- nothing in the whole project (the git repository) changed for N days
  (default 3, `--idle-days`), build output and `.git` aside;
- no running process has its working directory or executable inside the
  project;
- nothing wires the project to the running system: no command linked into a
  bin directory (`~/.local/bin`, `/usr/local/bin`, npm/pnpm/bun globals), no
  crontab or `/etc/cron.d` line, no systemd unit, no directory bind-mounted
  into a running container names it.

A `node_modules` in a folder that is not a project is not even listed.

A partial file goes only when nothing has written to it for 24 hours and no
process has it open. A cache goes only while its tool is not running. A
rotated log is compressed only when no process has it open.

Apply also never runs twice at once: a lock (in `$XDG_RUNTIME_DIR`, a tmpfs,
so it can be taken on a full disk) makes a second run on the same machine
exit with code 75 and touch nothing. That is what makes `--min-free-gb` safe
in cron.

## Finding the culprit

`report` answers "what is filling the disk right now" fast:

- **Writing to disk right now**: per-process `write_bytes` from `/proc/<pid>/io`
  sampled twice a few seconds apart (`--sample`), mapped to a docker
  container's name when the process runs in one. Without root only your own
  processes can be read.
- **Biggest directories**: the children of `~`, `/var/lib`, `/var/log`,
  `/opt`, `/srv`, `/tmp` and the like, sized several at a time, each `du`
  bounded (`--du-timeout`, default 20 s). One that runs out of time shows as
  `?`: it is the one to look inside first. Directories that look like
  databases, backups or media are called out for a human.
- **Growth**: each full report keeps a snapshot (in the plugin's settings), and
  the next one shows how much each filesystem and directory grew and the rate
  per hour.

The analysis writes no scratch files, so it works on a disk that is 100% full.

## Servers

A target is `local` or any name from `diskpush fleet servers` (saved
connections and `~/.ssh/config` hosts). The same programs run there over the
system `ssh` in BatchMode, so nothing ever waits on a password prompt; a
server that signs in with a password is listed but not usable. Nothing is
installed on the server; it needs a POSIX shell, `find`, `du` and `df`.

## Desktop

The **Cleaner** tab: pick a target and the categories, **Analyze**, read the
report (filesystems, writers, biggest directories, then every item with its
class and reason), tick what to remove (the plan is ticked for you; needs-a-
human items cannot be ticked), and confirm. The main process keeps the report
and the renderer only ever sends item ids from it, never a path. In the file
panes, right-click a folder for **Disk report: what can be freed here**.

## TUI

`a` on a directory: **Disk report: what can be freed here** sizes what is
inside, finds idle build output and stale partial files under it, and prints
the command that removes them.

## MCP

`diskpush clean mcp` serves the cleaner over MCP on stdio:

```json
{ "mcpServers": { "diskpush-cleaner": { "command": "diskpush", "args": ["clean", "mcp"] } } }
```

| Tool | Does |
| --- | --- |
| `clean_targets` | This machine and every server DiskPush knows |
| `clean_report` | The full analysis (read-only); the report is in `structuredContent` |
| `clean_apply` | A dry run unless `apply: true`; then only eligible, safe-class items; `only`, `ids` and `minFreeGb` narrow it |

## API

The core is the `@diskpush/plugin-cleaner` package: `scanTarget(ctx, target,
options)` returns the report, `applyClean(ctx, report, { apply, only, ids,
minFreeGb })` removes, `listTargets(ctx)` lists. The CLI's `--json` prints the
same objects.
