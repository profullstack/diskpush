# The file browser

## Two panes, either side anything

```text
LEFT                              RIGHT
Local / Server 1                  Remote / Server 2
```

The labels describe screen position, not direction. Each pane has an endpoint
selector, and either side can be the local machine or any saved server. That
gives three shapes:

```text
Local    → Server
Server   → Local
Server A → Server B
```

## Browsing is SFTP; transferring is rsync

```text
Local browsing   filesystem APIs
Remote browsing  SFTP over SSH
Transfers        rsync
Transport        SSH
```

rsync *can* list files, with `--list-only`. DiskPush does not use it for the
interactive browser, for two reasons:

1. It only lists. Renaming, chmod, mkdir and delete are not things rsync does,
   and a file manager needs all of them.
2. It re-establishes a session per invocation. SFTP holds one connection open
   and answers directory reads on it.

So SFTP is the browser and rsync is the engine, sharing the same SSH
connection infrastructure.

## ~/.ssh/config

A remote endpoint resolves in two steps: a saved DiskPush connection first,
then `~/.ssh/config`. So a host you already have in ssh_config works
everywhere without being imported.

This matters more than it sounds. Transfers got ssh_config for free, because
rsync shells out to ssh and ssh reads the file — but browsing did not, because
SFTP goes through ssh2, which has never read it. Before this, `diskpush
prod:/srv/` would transfer happily while `diskpush ls prod:/srv/` insisted the
host did not exist.

`diskpush connections import` still exists, and is worth using when you want to
attach a default path or a remote rsync path to a host.

## SFTP without rsync

A server can have SSH and SFTP but no rsync. DiskPush connects anyway:

```text
Connected via SFTP
Remote browsing available
rsync not found on server
Transfer/sync disabled
```

You keep the browser, so you can look at the machine and work out why, instead
of being locked out of a server by a missing package.

## Inspect before you mirror

This is the reason the browser and the delete preview are separate things.
Before a Mirror can run you get both:

1. **Human inspection.** The destination pane stays fully browsable. Navigate
   it, show hidden files, sort by date, read properties. DiskPush never hides
   the destination behind a summary dialog.
2. **A machine-generated change set.** A dry run with `--itemize-changes`
   produces the exact list of files that would be added, updated, left alone
   and deleted.

Then, and only then, the confirmation.

## The change set

Dry-run output is parsed into structured rows rather than shown as terminal
text:

| Action | Path | Source | Destination |
| --- | --- | --- | --- |
| Add | `new/video.mp4` | exists | missing |
| Update | `site/app.js` | newer | older |
| Metadata | `assets/` | same | timestamp differs |
| Delete | `old/archive.zip` | missing | exists |

These come from rsync's 11-character itemize string. `>f+++++++++` is a created
file, `>f.st......` is one whose contents and time changed, `.d..t......` is a
directory whose timestamp moved, and `*deleting` is what it looks like.

Unchanged rows are only available when itemize-all is on, because rsync reports
only changes by default. The unchanged *count* comes from `--stats`.

## After a transfer

Affected directories refresh, stale listing caches are dropped, and your
current path and selection are kept where they still exist. A manual refresh is
always available.
