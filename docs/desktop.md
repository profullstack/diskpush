# The desktop app

> Status: the Electron shell and its IPC surface exist. The two-pane browser is
> the current work. This document describes the intended behaviour; anything
> not yet built is marked.

## Layout

```text
┌────────────────────────────────────┬────────────────────────────────────┐
│ LEFT: Local / Server 1             │ RIGHT: Remote / Server 2           │
│ [ Local ▼ ]                        │ [ production ▼ ]                   │
│ /home/anthony/projects             │ /var/www                           │
├────────────────────────────────────┴────────────────────────────────────┤
│ Source: LEFT   Destination: RIGHT                                       │
│ [Preview Changes] [Sync →] [← Sync] [Mirror…]                           │
├─────────────────────────────────────────────────────────────────────────┤
│ Transfer Queue                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ Files │ Changes │ Failed │ Successful │ Profiles │ Logs                 │
└─────────────────────────────────────────────────────────────────────────┘
```

Either pane can be the local machine or any saved server, which is what makes
`Server A → Server B` an ordinary case rather than a special mode.

## Defaults

Dragging between panes uses the safe preset. No dialog appears first. The
status area states what is in effect:

```text
Mode: Incremental Sync
Archive metadata: On
Resume partial transfers: On
Skip unchanged files: On
Delete destination-only files: Off
```

## Saved pairs

The strip above the panes holds saved profiles: click one to restore its
source, destination and options, **Save this pair** stores what is on screen,
and the × deletes it. A profile with deletes enabled carries a red **mirror**
mark.

These are the same profiles the CLI uses — a pair saved here runs with
`diskpush profile run NAME`. See [profiles.md](profiles.md).

## Mirror

The destination pane stays browsable right up to the confirmation: you can
navigate it, show hidden files and read properties while deciding. Then a dry
run produces the exact change set, the deletions are listed individually, and
only then is the button enabled.

## Queue

States: `queued`, `scanning`, `running`, `paused`, `interrupted`, `retrying`,
`completed`, `failed`, `cancelled`.

One active rsync per remote connection by default, configurable to 8 globally.
The default exists because eight simultaneous rsyncs against one server is
usually slower than one, not faster.

Pause is implemented as stop-and-resume: rsync has no portable pause. The
process is stopped with SIGINT so it cleans up and leaves its partial file, the
job is marked `interrupted`, and resuming re-runs it. The label says Pause
because that is what it does from where you are sitting.

## Fleet

**Fleet** is one of the two tabs in the header, beside **Transfer**. It is the
other thing you do with a list of servers: run one command on many of them.

```text
┌ DiskPush │ 7 servers │ [ Transfer ][ Fleet ]          [New server] [⚙] ┐
├──────────────┬─────────────────────────────────────────────────────────┤
│ SERVERS 4/7  │ Recipes  [check-updates][upgrade][disk][uptime][who]     │
│ [production] │ ┌─────────────────────────────────────────────────────┐ │
│ [web] [db]   │ │ set -e                                            ▲ │ │
│              │ │ pm=$(if command -v apt-get >/dev/null 2>&1; then   │ │
│ ☑ web-01     │ │ ...                                               ▼ │ │
│ ☑ web-02     │ └─────────────────────────────────────────────────────┘ │
│ ☑ web-03     │ 57 lines · runs under sh -e                             │
│ ☑ db-01      │ ☑ sudo   At once [4]  Timeout [3600]s  ☐ Stop on fail   │
│ ☐ cache-01   ├─────────────────────────────────────────────────────────┤
│ ☐ staging    │ ✓ web-01  Succeeded  3.1s                               │
│              │ ! web-02  Failed  exit 100                              │
│              │   E: Could not get lock /var/lib/dpkg/lock-frontend     │
│              │ ⚡ web-03  Unreachable  15.0s                            │
├──────────────┴─────────────────────────────────────────────────────────┤
│ [▶ Run on 4 servers] [Check for updates]           2 ok · 2 failed     │
└────────────────────────────────────────────────────────────────────────┘
```

A tab rather than a dialog, deliberately. This is somewhere you sit for
minutes with a long script in front of you while a dozen servers report — all
the things a modal is wrong for. Fleet shipped as a modal in v0.2.8 and the
`upgrade` recipe's fifty-seven lines pushed **Run** off the bottom of it,
where nothing could scroll it back.

So the layout has exactly three scrolling regions — the server list, the
script editor, and the results — and **the action bar is pinned outside all
of them**. Run is on screen at the 960×600 minimum window size just as it is
maximised.

The command strip above the editor holds the shipped recipes and anything you
have saved. Editing the script or the settings offers **Save these settings**,
which stores the script, the interpreter, sudo, the timeout, how many servers
at a time, and whether a failure stops the rest — picking it again restores all
of it. A saved command carries an × to delete it; a shipped recipe does not,
because it is copied rather than edited.

Saved **lists** sit at the top of the sidebar, above the tag chips. Clicking
one ticks exactly its members; ticking servers by hand offers **Save these 3**;
the × on a chip deletes the list and leaves the servers alone. A member whose
connection has been deleted is named rather than silently skipped.

Ticking servers is the same thing `--on` does in the CLI, and tag chips filter
the list. The two share one local database, so a command saved in one runs
from the other.

Each host gets its own card with its own live output. Nothing is summarised as
"done" on behalf of a server that has not said so, and a server that could not
be reached reads **Unreachable** rather than **Failed** — the command did not
run there, which is a different situation from a command that ran and failed.

**Check for updates** is the read-only sweep: pending updates, security
updates where the package manager can separate them, whether a reboot is
pending, and root filesystem use. It installs nothing. A count DiskPush could
not obtain shows as `?` and never as `0`.

A command matching a destructive pattern raises **a modal** — the one
genuinely modal thing here, a yes/no you must answer before anything happens.
It names what it matched and how many servers it would reach. That check is
repeated in the main process, so it is not something the window can be talked
out of.

## Switching tabs keeps your work

Both views stay mounted; the inactive one is hidden, not destroyed. Clicking
Transfer to check a path and coming back finds the Fleet view exactly as you
left it — the script, the ticked servers, the output of a run still going.

The Fleet editor's contents also survive quitting the app. That is the
*unsaved draft*: the thing you have not decided to name yet, kept in the
window's own storage as a safety net under **Save these settings**. A sudo
password is never part of it.

## Keyboard

```text
Ctrl/Cmd + K      Command palette
Ctrl/Cmd + L      Focus the path bar
Ctrl/Cmd + R      Refresh
Ctrl/Cmd + U      Upload selected
Ctrl/Cmd + D      Download selected
Ctrl/Cmd + P      Preview sync
Ctrl/Cmd + Enter  Run sync
Delete            Delete selected
F2                Rename
```

## Security

See [security.md](security.md#electron). The renderer is sandboxed, has no Node
APIs, and every IPC input is validated in the main process.
