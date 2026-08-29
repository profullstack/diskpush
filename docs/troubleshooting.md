# Troubleshooting

## "DiskPush could not find rsync on this computer."

Install it:

```bash
sudo apt install rsync openssh-client   # Debian / Ubuntu
brew install rsync                      # macOS, for a modern version
```

## "SSH connected successfully, but rsync is not installed on the remote server."

Browsing still works: you can navigate the server over SFTP and see what is
there. Only transfers are disabled. Install rsync on that host.

## "The SSH host key for HOST has changed. Connection blocked for safety."

DiskPush recorded a different key for this host previously. Either the server
was rebuilt or reinstalled, or the connection is being intercepted.

If you know why it changed, remove the old entry deliberately:

```bash
ssh-keygen -R hostname
ssh-keygen -R '[hostname]:2222'   # non-default port
```

DiskPush keeps its own `known_hosts` under `$XDG_CONFIG_HOME/diskpush/`.

## "SSH authentication was rejected."

```bash
ssh -v deploy@example.com   # what does OpenSSH say?
ssh-add -l                  # is the key actually in the agent?
```

DiskPush connects with `BatchMode=yes`, so a missing key fails immediately
rather than hanging on a password prompt nobody can see.

## "The remote user does not have permission to write to the destination path."

The path exists but the SSH user cannot write to it. Check ownership on the
server. `--mkpath` creates a missing destination directory, but needs rsync
3.2.3+ on both ends.

## "Transfer stopped because the destination filesystem is out of space."

Partial data was preserved where possible. Free space and re-run the same
command; it continues from the partial file.

## A transfer stopped and says "resumable"

That is not a failure. rsync exited with a code that means the data on disk is
intact (10, 11, 12, 20, 23, 30 or 35, or a signal). Run the same command again.

```bash
diskpush jobs --state interrupted
```

## The second run transferred everything again

Something is defeating the quick check. Usual causes:

- **A destination filesystem that cannot hold modification times.** Common on
  FAT, exFAT and some network mounts. rsync sees a different mtime every time.
- **`--checksum` left on**, which ignores the quick check by design.
- **Copying across a timezone-naive filesystem**, where timestamps drift.

Confirm with a dry run: `diskpush SRC DST --dry-run` lists what it thinks
changed.

## Mirror will not run

```text
Mirror would delete 87 files at the destination. Re-run with --yes to confirm,
or without --non-interactive to be asked.
```

Working as intended. Review the delete list, then confirm with `--yes`.

## "These pass-through arguments were rejected"

`--delete` and its relatives are refused after `--`, because they would turn a
sync into a mirror behind the preview. Use `diskpush mirror`.
`--remove-source-files` is refused because it deletes the source.

## A path with spaces or quotes

Works. Paths are argv tokens, not shell text. If you see a *warning* about
whitespace, it is about the SSH transport options rather than the path: rsync
splits its `--rsh` value on spaces with no quoting, so a key path containing a
space is unrepresentable. Put that host in `~/.ssh/config` and reference the
alias.

## Server-to-server says it is unavailable

```text
Direct server-to-server transfer is unavailable.
Server A cannot currently connect or authenticate to Server B.
```

Test it from where it actually happens, on Server A:

```bash
ssh server-a
ssh -o BatchMode=yes server-b true
```

DiskPush will not fall back to relaying the files through your machine. Fix the
hop: authorise a key for Server B on Server A, or enable agent forwarding on
the connection.

## Progress does not move on a large file

`--info=progress2` reports overall progress across the whole transfer. Early in
a large tree, rsync is still building the file list, so the counter can sit at
zero for a while. `--stats` at the end gives exact totals.

## Seeing what is actually run

```bash
diskpush ... --print-args
```

Always available, on every command, including server-to-server, where it shows
the control session and the remote rsync command separately.
