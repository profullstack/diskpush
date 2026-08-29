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
