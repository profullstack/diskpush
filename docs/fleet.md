# Fleet

One command, many servers.

The rest of DiskPush moves bytes to a server. Fleet moves *work* to a set of
them — a package upgrade, a health check, a script you already have — and
reports every server separately.

```bash
diskpush fleet check --on tag:production
diskpush fleet upgrade --on tag:production --sudo
diskpush fleet run "systemctl reload nginx" --on 'web-*' --sudo
diskpush fleet script ./rotate-keys.sh --on all '!db-01'
```

In the desktop app it is the **Fleet** button in the header: tick the servers
on the left, type a command or pick a recipe, watch each host report on its
own.

## Choosing servers

`--on` takes any number of terms, repeated or comma-separated. They are the
same terms the desktop's checkboxes and tag filter produce.

```text
all                every server DiskPush knows about
web-01             one, by name (or by id)
web-*              a glob over names, `*` and `?` only
tag:production     every server carrying that tag
host:10.0.0.*      a glob over hostnames
!web-03            remove one from the set
!tag:canary        remove a whole tag from the set
```

Includes are unioned, then exclusions are subtracted, so order does not
matter: `tag:web !web-03` and `!web-03 tag:web` select the same servers.

Both saved connections and `~/.ssh/config` hosts are selectable. A saved
connection wins a name clash. `diskpush fleet servers` lists what is available
and where each entry came from.

**A term that matches nothing is an error, not a smaller fleet.** `--on web-O3`
with a letter O fails rather than quietly upgrading eleven of your twelve
servers. The same is true of an exclusion: `!web-O3` was meant to protect a
server, and silently protecting none is worse than stopping.

## What each command does

### `fleet check`

Asks every selected server what it needs. Installs nothing, takes no package
manager lock, and needs no root, so it is safe to run at any hour.

```bash
diskpush fleet check --on all
```

```text
SERVER   OS                  PM   UPD  SEC  REBOOT  DISK  UPTIME
-------  ------------------  ---  ---  ---  ------  ----  ------
web-01   Ubuntu 24.04.1 LTS  apt  14   3    YES     61%   142d
web-02   Ubuntu 24.04.1 LTS  apt  0    0    no      48%   3d
db-01    Rocky Linux 9.4     dnf  7    1    no      72%   9d
```

`?` means DiskPush could not obtain that number, and `—` means the package
manager cannot report it at all. Neither is ever shown as `0`: "nothing
pending" is a claim, and it has to be earned.

`--pending` hides the servers with nothing to do.

### `fleet upgrade`

Installs what `check` found.

```bash
diskpush fleet upgrade --on tag:production --sudo --concurrency 2
```

The package manager is detected **on each host**, inside the script, so one
command covers a fleet that mixes Debian, Rocky and Alpine. `apt`, `dnf`,
`yum`, `zypper`, `pacman`, `apk`, `brew` and `pkg` are driven.

Every invocation is non-interactive and answers "keep the installed config
file" where the question comes up, because a fleet upgrade that stops on a
conffile prompt on host four has already failed. Nothing is removed:
`upgrade`, never `dist-upgrade` or `autoremove`, because both can take away
something that is running.

Rebooting is **off** by default; the run tells you which servers need one.

```bash
diskpush fleet upgrade --on tag:web --sudo --reboot           # only those that need it
diskpush fleet upgrade --on tag:web --sudo --reboot=always    # all of them
```

Either form names the servers it will restart and asks first, unless `--yes`.

### `fleet run` and `fleet script`

```bash
diskpush fleet run "df -h /" --on all
diskpush fleet run --command reload-nginx --on tag:web
diskpush fleet script ./deploy.sh --on tag:web --sudo
```

`run` with a quoted string runs it as a single command line. `script` reads a
local file and pipes it to `sh` — or to `bash`, if the file starts with a
`#!` line naming it.

A script runs under `sh -e`: it stops at the first failing command, which is
what someone writing a three-line deploy step assumes already happens. Pass
`--no-fail-fast` for a probe whose commands are expected to fail.

### `fleet commands`

Saved commands, plus the recipes DiskPush ships (`check-updates`, `upgrade`,
`reboot-required`, `disk`, `uptime`, `who`).

```bash
diskpush fleet commands
diskpush fleet commands save reload-nginx "systemctl reload nginx" --sudo --on tag:web
diskpush fleet commands copy upgrade my-upgrade    # built-ins are copied, not edited
diskpush fleet run --command reload-nginx          # --on comes from the saved default
```

A built-in cannot be edited or deleted, only copied, so upgrading DiskPush
never silently changes a command you rely on. A saved command with the same
name as a built-in shadows it.

### `fleet runs` and `fleet show`

Every run is recorded before it starts, and each host's result is written as
it finishes — so a run you interrupt still has the results it collected.

```bash
diskpush fleet runs
diskpush fleet show af4769db          # full output for the hosts that failed
diskpush fleet show af4769db --all    # and for the ones that did not
```

A run stores the script it ran, not a pointer to the command it came from.
Editing a saved command does not rewrite the history of what was executed on
production last Tuesday. It stores the server's name and hostname the same
way, so a renamed or deleted connection does not turn a post-mortem into
"the host that used to be id 7f3a".

## How it runs

**Concurrency is bounded**, four at a time by default (`--concurrency`).
Forty simultaneous SSH connections is a way to get rate-limited by your own
bastion.

**Every host has a deadline**, 900 seconds by default and 3600 for an upgrade
(`--timeout`). A host still running at the deadline is signalled and reported
as `timeout`, not as a failure of the command.

**Failure does not stop the fleet** unless you ask. `--stop-on-error` stops
*queuing* further servers; hosts already running are left to finish, because
killing a package manager mid-transaction to enforce a policy about a
different server leaves a broken dpkg behind.

**Ctrl-C stops a run** rather than killing the process: servers already
running are signalled, the rest are cancelled, and everything collected so far
is still recorded.

### Reachable, failed, and timed out are three different things

| State | What it means |
| --- | --- |
| `succeeded` | The command ran and exited 0. |
| `failed` | The command ran and exited non-zero. Its own exit code is recorded. |
| `unreachable` | DiskPush never got a session. The command did not run. |
| `timeout` | Still running at the deadline. |
| `cancelled` | The run was stopped before this host finished, or before it started. |

Collapsing `unreachable` into `failed` is how a fleet tool ends up reporting a
server that was simply switched off as a failed deploy.

## Root

`--sudo` runs through `sudo -n`, which fails immediately when a password is
wanted rather than hanging forever on a prompt nobody can see. That failure is
reported as what to do about it, not as sudo's own wording.

```bash
diskpush fleet run "systemctl restart nginx" --on tag:web --sudo
diskpush fleet run "systemctl restart nginx" --on tag:web --sudo-password
```

`--sudo-password` asks once, without echo, and feeds it to `sudo -S` on each
host's stdin. It is held in memory for the length of the run: it is never
written to the database, never logged, and never part of the command line —
so it cannot appear in `ps` output on the server either.

## Safety

### The command is never assembled from your text

Script text goes to the remote interpreter on **stdin**. The command line only
ever names the interpreter (`/bin/sh -es`). A quote, a backtick or a newline
in your script cannot become a different command than the one you wrote —
your bytes arrive as your bytes.

`--interpreter raw` is the exception, for `uptime` and
`systemctl status nginx`, where wrapping the text is more ceremony than the
job needs.

### Destructive patterns need saying so

A script matching a known way to lose a machine does not fan out until you
confirm it — the same bargain as Mirror on the transfer side, which always
shows the delete list first.

```text
$ diskpush fleet run "rm -rf $CACHE/" --on tag:web

This command matches a pattern that can destroy a server:

  line 1: Recursive forced delete. On the wrong path this removes the system.
    rm -rf $CACHE/

It would run on 6 server(s).
Run it anyway? [y/N]
```

Caught: recursive deletes of `/` (including the `"$UNSET/"` form, which is how
this usually happens), `mkfs` and friends, raw writes to block devices, power
commands, changes to SSH or the firewall, permission resets from the root
down, account deletion, fork bombs, piping a URL into a shell, and `DROP
DATABASE`.

This is a tripwire, not a sandbox. A shell is Turing-complete and anything
here can be written around in ten seconds. It catches the accident, and the
accident is what actually happens.

In the desktop app the same check runs in the **main process**, not the
renderer: the dialog showing you a confirmation is what makes it true, and a
renderer that skipped the dialog cannot skip the check with it.

### Unknown host keys fail

A fan-out is the wrong moment to be answering host key prompts one at a time,
so a host that is not in `known_hosts` fails rather than asking. Check it once
with `diskpush connections test NAME`, or pass `--accept-new` deliberately for
that run. A *changed* key is never accepted, by `--accept-new` or anything
else.

## Exit codes

`0` when every server succeeded, `71` when any did not. Deliberately one code
rather than the failing host's own status: across twelve servers there may be
several, and picking one to pass through would mean inventing a winner.

`--json` carries every host's real exit code, stdout, stderr and duration.

```bash
diskpush fleet run "nginx -t" --on tag:web --json | jq '.hosts[] | select(.state != "succeeded")'
```
