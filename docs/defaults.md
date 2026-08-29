# Defaults

DiskPush has opinions. The point of them is that the common case should not
require you to know rsync.

## The default transfer

Every transfer that is not told otherwise runs as:

```bash
rsync \
  --archive \
  --partial-dir=.rsync-partial \
  --human-readable \
  --itemize-changes \
  --info=progress2 \
  SOURCE \
  DESTINATION
```

So these are the same thing:

```bash
diskpush ./data/ server:/data/
diskpush sync ./data/ server:/data/
```

`diskpush --print-args` prints the exact command for any job, so you never have
to take this document's word for it.

## What each default buys you

### Incremental

rsync's quick check compares size and modification time. A file that matches on
both is not sent. Re-running a finished job therefore moves almost nothing,
which is the entire reason to prefer rsync over an SFTP upload.

Turn this off with `--checksum`, which compares content hashes instead. It is
correct in more cases and much slower, because every candidate file has to be
read on both ends.

### Recursive

Directories are traversed. There is no separate recursion switch for ordinary
folder work; `--archive` implies `-r`.

### Archive

`--archive` is `-rlptgoD`: recursion, symlinks, permissions, modification
times, group, owner (where permitted), and device and special files (where
permitted).

It does **not** include hard links, ACLs, or extended attributes. Those cost
extra scanning and need support at both ends, so they are separate options:
`--hard-links`, `--acls`, `--xattrs`.

### Resumable

`--partial-dir=.rsync-partial` keeps the bytes that did arrive, in a directory
beside the destination file rather than in place of it. Two consequences worth
understanding:

- An interrupted transfer can pick up where it stopped.
- A half-received file is never presented as if it were the finished one. That
  is the difference between `--partial-dir` and a bare `--partial`, and it is
  why DiskPush uses the former.

A job that stops this way is reported as **Interrupted - resumable**, not as
Failed, because those are different situations.

### Non-destructive

No delete flag is ever added by default. Copy, push, pull, sync, archive,
backup, publish, and deploy all leave destination-only files alone.

Deleting requires Mirror, which is a separate command and a separate
confirmation. See [rsync-options.md](rsync-options.md#mirror-mode).

## What is *not* on by default

| Option | Why it is off |
| --- | --- |
| Compression | It trades CPU for bandwidth. That is the right trade on a slow WAN and the wrong one on a fast LAN, and DiskPush will not guess. Use `--compress` or the `slow-wan` preset. |
| Checksums | Reads every file on both ends. Use `--checksum` when you have a reason to distrust timestamps. |
| Hard links, ACLs, xattrs | Extra scanning, and both ends must support them. Use `--hard-links`, `--acls`, `--xattrs`, or the `maximum-metadata` preset. |
| `--inplace` | Changes failure semantics: an interrupted transfer can leave a destination file partially overwritten. |
| Deletion | See above. |

## A note on `--human-readable`

It is on by default because the PRD specifies it and because the command
DiskPush prints should be the command you would have typed. It does mean rsync
rounds its progress byte counter to three significant figures, so the live
progress number is approximate. Exact totals come from `--stats`.

## Intents

`push`, `pull`, `publish`, `deploy`, and `backup` are the same engine with the
same defaults. They exist so a script says what it means. Only `mirror` behaves
differently, and it is the only one that can delete.
