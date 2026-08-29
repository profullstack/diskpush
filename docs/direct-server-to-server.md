# Direct server-to-server transfers

> DiskPush orchestrates the job. The file payload goes directly from Server A
> to Server B. DiskPush does not proxy, relay, stage, or store the transferred
> files, and neither does your desktop.

## What actually happens

```text
┌──────────────────┐
│ DiskPush         │
│ orchestration    │
└────────┬─────────┘
         │ SSH control only
         ▼
┌──────────────────┐      rsync over SSH       ┌──────────────────┐
│ Server A         │ ========================> │ Server B         │
│ source           │       file payload        │ destination      │
└──────────────────┘                           └──────────────────┘
```

A single rsync process cannot have two remote endpoints. So DiskPush connects
to the source host and starts rsync *there*, with the destination as its
remote:

```bash
ssh media-01 'rsync --archive --partial-dir=.rsync-partial \
  --human-readable --itemize-changes --info=progress2 \
  /srv/media/ backup-02:/data/media/'
```

The rsync process on Server A opens its own SSH connection to Server B. The
bytes go over that connection. DiskPush holds the control session, reads
progress and log output from it, and nothing else.

`diskpush --print-args` shows both halves separately:

```text
rsync --archive --partial-dir=.rsync-partial ... /srv/media/ backup-02:/data/media/
# control session: ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new media-01
```

## What crosses your machine

| Data | Crosses the desktop |
| --- | --- |
| Directory listings, for the panes | Yes |
| Progress counters, file names, rsync output, errors | Yes |
| **File contents** | **No** |

Listings and progress are control-plane data: the desktop must render the panes
and the progress bar. File payload is not, and does not.

## Quoting

`ssh host command...` always runs the command through the remote user's login
shell; it joins its remaining arguments with spaces and hands the result over.
There is no way to avoid that shell, so DiskPush quotes for it explicitly:
every token of the remote rsync command is POSIX single-quoted, and the whole
thing is passed as one argv element.

This is the only shell anywhere in DiskPush, and it is tested with paths
containing `$(...)`, backticks, semicolons, spaces and embedded single quotes.
Everything else spawns with `shell: false` and an argument array.

## Authentication

Server A has to be able to reach Server B. Three ways, in order of preference:

### A key on Server A, authorised on Server B

The straightforward option, and the only one that works unattended. Best done
with a key dedicated to this transfer rather than a general-purpose personal
key, so its reach is bounded.

### A dedicated transfer key

Same as above, but scoped: a key that exists only to move this directory. On
Server B, restrict it in `authorized_keys`:

```text
command="rrsync -wo /data/media",restrict ssh-ed25519 AAAA... diskpush-transfer
```

### Agent forwarding

Opt-in, per connection, and off by default. DiskPush connects to Server A with
`ssh -A`, and the rsync process there authenticates to Server B using your
agent, without your private key ever being copied to Server A.

The reason it is off by default: while the job runs, anyone with root on
Server A can use your forwarded agent to authenticate as you, anywhere. That is
a real cost, and it should be a decision rather than a default.

## Preflight

Before a server-to-server job starts, DiskPush checks, in order:

```text
DiskPush → Server A       ok
rsync on Server A         ok 3.2.7
Server A → Server B       ok
rsync on Server B         ok 3.2.7
Destination writable      ok
Direct transfer available ok
```

Each check runs from the place that matters. "Server A → Server B" is tested
by executing `ssh -o BatchMode=yes SERVER_B true` *on Server A*, so it reflects
Server A's actual network position and credentials rather than yours.
`BatchMode=yes` matters: without it a missing key produces a password prompt
into a session nobody is watching, and the check hangs instead of failing.

## When it cannot work

If Server A cannot reach or authenticate to Server B, DiskPush says so and
stops:

```text
Direct server-to-server transfer is unavailable.
Server A cannot currently connect or authenticate to Server B.
```

It does **not** fall back to pulling the files down and pushing them back up.
That would be slower, would consume your bandwidth, and would quietly break the
guarantee at the top of this page. A desktop-relay mode could exist one day as
a feature someone explicitly chooses. It will never be an automatic fallback.

## Limits today

If DiskPush exits, the controlling SSH session closes and the remote rsync
stops with it. A later version will support a small remote job wrapper so a
long transfer survives the desktop disconnecting.

That wrapper stays control-plane only. The payload path remains Server A to
Server B; no DiskPush-hosted relay is introduced by it.
