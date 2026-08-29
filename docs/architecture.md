# Architecture

## Packages

```text
packages/schemas      Typed option model, endpoints, jobs, profiles. Zod.
packages/rsync-core   Argument builder, execution planner, parsers, runner.
packages/ssh-core     SSH sessions, SFTP browsing, host keys, preflight.
packages/database     The local store, shared by every surface.
apps/cli              The `diskpush` command.
apps/desktop          Electron main, preload, and the renderer.
apps/web              diskpush.com.
```

`rsync-core` has no dependency on Electron, on the CLI, or on the database. It
takes endpoints and options and produces a command and a stream of events.
That boundary is what lets the same engine back a daemon, an HTTP API or an
MCP tool later without being rewritten.

## Endpoints are values

```ts
type Endpoint =
  | { type: 'local'; path: string }
  | { type: 'ssh'; host: string; user?: string; port?: number; path: string }
```

Not strings. A string endpoint gets concatenated, and concatenation is how
injection happens. Parsing occurs once, at the edge; everything downstream
works with the structured form, and rendering back to `host:path` happens in
one function.

The port deliberately lives on the endpoint but is never rendered into it: it
belongs in the SSH transport, because `host:port:/path` is not something rsync
understands.

## Planning and running

```ts
planTransfer(input) -> ExecutionPlan { binary, args, display, direct, warnings }
runPlan(plan)       -> AsyncIterable<RsyncEvent>
```

`planTransfer` decides the topology and produces a spawnable command:

| Topology | Binary | Shape |
| --- | --- | --- |
| local → local | `rsync` | direct |
| local → remote | `rsync` | `--rsh` carries the SSH transport |
| remote → local | `rsync` | as above |
| remote → remote | `ssh` | rsync runs on the source host |

For server-to-server, the source path is rebuilt as a *local* path (it is local
from the source host's point of view), the whole rsync command is quoted for
the remote login shell, and it travels as a single argv element. See
[direct-server-to-server.md](direct-server-to-server.md).

`ExecutionPlan.display` is the human-readable command. It is what
`--print-args` shows and what goes in the log. It is never executed.

## Events

```ts
type RsyncEvent =
  | { type: 'start'; command: string; args: readonly string[] }
  | { type: 'progress'; progress: RsyncProgress }
  | { type: 'change'; change: Change }
  | { type: 'stats'; stats: RsyncStats }
  | { type: 'stderr' | 'stdout'; line: string }
  | { type: 'exit'; code: number; resumable: boolean; message: string }
```

Parsing happens where the process is, so no consumer re-implements it. Two
details that only surface against the real binary:

- Progress uses `\r` to redraw in place, so a chunk splitter that only breaks
  on `\n` never emits a progress line until the job ends.
- With `--human-readable` on, the byte column reads `8.39M`, not `8,388,608`.
  A parser written against the documented non-human form silently matches
  nothing.

## Process boundaries in the desktop app

```text
Renderer (Next.js, React, shadcn/ui)
        │  typed IPC only
Preload (contextBridge)
        │
Main process
        │  ConnectionService, SshService, SftpBrowserService,
        │  RsyncService, QueueService, ProfileService,
        │  CredentialService, DatabaseService, SchedulerService
        ├── SSH / SFTP  ──> remote host
        └── child_process ──> rsync
```

The renderer has `nodeIntegration: false`, `contextIsolation: true`, and a
sandbox. It never receives filesystem or process APIs, only narrowly scoped IPC
operations. Every IPC input is validated with Zod in the main process, because
a renderer compromise must not become a shell.

## The store

One SQLite/libSQL database under `$XDG_CONFIG_HOME/diskpush/` (or
`$DISKPUSH_HOME`), holding connections, profiles, jobs, events and settings.
Both the desktop app and the CLI open it, so a connection saved in one is
immediately usable from the other.

It holds no credential material. There is no column for a password or a
passphrase; those belong in OS-backed secure storage.

## Testing

- **Unit tests** cover the argument builder, capability gating, parsers, exit
  code interpretation, endpoint parsing, quoting, and CLI argument handling.
- **Live tests** (`tests/live`) run the real rsync binary against temporary
  directories and assert the product's actual claims: unchanged files are
  skipped, one changed file transfers alone, archive metadata survives, a
  mirror previews before it deletes, hostile paths stay paths, and an
  interrupted transfer resumes from its partial file.

The second group exists because the first cannot catch a wrong belief about
rsync. Both of the parser bugs above were found by it.
