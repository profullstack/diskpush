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

The **Fleet** button in the header opens the other thing you do with a list of
servers: run one command on many of them.

```text
┌──────────────┬──────────────────────────────────────────────────────────┐
│ Servers 3/12 │ Recipes: [check-updates] [upgrade] [disk] [uptime] …     │
│ [production] │ ┌──────────────────────────────────────────────────────┐ │
│ [web] [db]   │ │ systemctl reload nginx                               │ │
│              │ └──────────────────────────────────────────────────────┘ │
│ ☑ web-01     │ ☑ sudo   At once [4]  Timeout [900]s  ☐ Stop after fail  │
│ ☑ web-02     │ [Run on 3 servers] [Check for updates]                   │
│ ☑ web-03     ├──────────────────────────────────────────────────────────┤
│ ☐ db-01      │ ✓ web-01  succeeded  0.4s                                │
│ ☐ …          │ ⟳ web-02  running    …                                   │
│              │ ! web-03  failed  exit 1  nginx: configuration test …    │
└──────────────┴──────────────────────────────────────────────────────────┘
```

Tag chips filter the server list; ticking servers is the same thing `--on` does
in the CLI, and the two share one local database, so a command saved in one
runs from the other.

Each host gets its own card with its own live output. Nothing is summarised as
"done" on behalf of a server that has not said so, and a server that could not
be reached reads **Unreachable** rather than **Failed** — the command did not
run there, which is a different situation to a command that ran and failed.

**Check for updates** is the read-only sweep: pending updates, security
updates where the package manager can separate them, whether a reboot is
pending, and root filesystem use. It installs nothing.

A command matching a destructive pattern shows what it matched and needs an
explicit tick before it will run. That check is repeated in the main process,
so it is not something the window can be talked out of.

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
