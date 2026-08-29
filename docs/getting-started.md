# Getting started

## Requirements

DiskPush drives rsync and SSH rather than reimplementing them, so both need to
exist:

- **On this machine:** `rsync` and an SSH client.
- **On any server you transfer to or from:** `rsync`.

```bash
# Debian / Ubuntu
sudo apt install rsync openssh-client
```

Linux is the reference platform. macOS works; its system rsync is old enough
that a Homebrew rsync is worth having for zstd compression and `--mkpath`.

## Your first transfer

Nothing needs to be configured to move files between two local paths, which is
a good way to see the defaults work:

```bash
diskpush ./photos/ /mnt/backup/photos/
```

Run it twice. The second run transfers nothing, because nothing changed. That
is the whole idea.

## Adding a server

```bash
diskpush connections add production deploy@example.com --port 22 --path /srv/app
```

Or import what you already have:

```bash
diskpush connections import
```

Then check it end to end:

```bash
diskpush connections test production
```

```text
SSH                 ok    deploy@example.com:22
SFTP browsing       ok    available
Remote rsync        ok    3.2.7
zstd compression    ok    supported
ACL preservation    ok    supported
xattr preservation  ok    supported
Home directory      ok    /home/deploy
```

The first connection to a host shows its fingerprint and asks once. After that
the key is remembered, and a *change* to it blocks the connection rather than
asking again.

This command also records what that server's rsync can do, so later transfers
gate options on the remote's real capabilities instead of assuming yours apply
to both ends.

## Look before you leap

```bash
diskpush ls production:/srv/app
diskpush ./dist/ production:/srv/app/ --dry-run
```

The dry run prints the change set: what would be added, updated, and left
alone. Nothing moves.

## Transfer

```bash
diskpush ./dist/ production:/srv/app/
```

To see exactly what is being run, at any time:

```bash
diskpush ./dist/ production:/srv/app/ --print-args
```

## Excluding things

```bash
diskpush ./site/ production:/var/www/site/ \
  --exclude-preset node \
  --exclude-preset git \
  --exclude 'private/'
```

## Saving it

```bash
diskpush profiles save website ./site/ production:/var/www/site/ \
  --exclude-preset node --exclude-preset git

diskpush profile run website
```

Profiles are shared with the desktop app: one saved here shows up there.

## Deleting stale files

`sync` never deletes. When you do want the destination to match the source
exactly, that is `mirror`, and it will show you the list first:

```bash
diskpush mirror ./site/ production:/var/www/site/
```

```text
Action     Files
---------  -----
Add        12
Update     3
Unchanged  8442
Delete     87

These destination files would be deleted:
  old/2019-promo.html
  ...

Delete 87 files at the destination? [y/N]
```

In a script, `--yes` confirms and `--non-interactive` guarantees it will exit
`66` rather than wait for someone who is not there.

## Server to server

```bash
diskpush media-01:/srv/media/ backup-02:/data/media/
```

The files move directly between those two servers. See
[direct-server-to-server.md](direct-server-to-server.md).

## When something stops

An interrupted transfer is reported as resumable, not failed. Re-run the same
command; rsync picks up from the partial file:

```bash
diskpush jobs
diskpush ./big-media/ backup-02:/data/media/   # continues
```
