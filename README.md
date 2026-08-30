# DiskPush

**Push files fast. Sync only what changed.**

DiskPush is a desktop app and CLI for rsync. Browse servers like FileZilla, and
transfer with rsync so unchanged files are skipped, interrupted transfers
resume, and metadata survives.

```bash
diskpush ./dist/ prod:/srv/app/            # local  -> server
diskpush prod:/var/log/app/ ./logs/        # server -> local
diskpush server-a:/data/ server-b:/backup/ # server -> server, directly
diskpush ./data/ prod:/data/ -- --checksum # your own rsync flags
```

- **Local → server**, **server → local**, and **server → server** directly.
- **Archive metadata by default.** Permissions, timestamps, symlinks.
- **Resumable by default.** An interrupted transfer keeps its partial data.
- **Skips unchanged files.** Re-running a job moves almost nothing.
- **Never deletes** destination-only files unless you explicitly enable Mirror,
  and Mirror always shows you the delete list first.
- **One command, many servers.** Package upgrades, a health sweep, or a script
  you already have — run across a whole tagged fleet from the Fleet tab or the
  CLI, each server reported separately.
- **No cloud account, no relay.** For a server-to-server job the payload moves
  directly between the two servers; DiskPush only orchestrates.

## Why

An SFTP client re-uploads a folder every time you change one file in it.
rsync does not, but it means remembering which of its two hundred flags you
wanted. DiskPush is the browser you expect on top of the transfer engine you
want, with the flags you would have chosen already on.

Running

```bash
diskpush ./data/ server:/data/
```

is equivalent to

```bash
rsync --archive --partial-dir=.rsync-partial --human-readable \
      --itemize-changes --info=progress2 ./data/ server:/data/
```

and `diskpush --print-args` will always show you exactly what it is about to run.

## Install

```bash
curl -fsSL https://diskpush.com/install.sh | sh
```

Installs the CLI, and the desktop app when the machine has a desktop to run it
on. Everything lands under your home directory: no root, no package manager.
Add `-s -- --cli-only` for a server. See [docs/install.md](docs/install.md).

DiskPush needs `rsync` and an SSH client on the machine it runs on, and `rsync`
on any server it talks to.

```bash
# Debian / Ubuntu
sudo apt install rsync openssh-client
```

From source:

```bash
git clone https://github.com/profullstack/diskpush
cd diskpush
pnpm install
pnpm build
node apps/cli/dist/bin.js --help
```

## Quick start

```bash
# Save a server
diskpush connections add production deploy@example.com --port 22 --path /srv/app

# Check SSH, SFTP and the remote rsync in one step
diskpush connections test production

# Look around
diskpush ls production:/srv/app

# See what a sync would do, without doing it
diskpush ./dist/ production:/srv/app/ --dry-run

# Do it
diskpush ./dist/ production:/srv/app/

# Ask every production server what it needs
diskpush fleet check --on tag:production

# Install it
diskpush fleet upgrade --on tag:production --sudo

# Or run anything, anywhere
diskpush fleet run "systemctl reload nginx" --on 'web-*' --sudo
```

## Safety

DiskPush is built to be trusted with a `--delete` flag, which means it is built
to make that flag hard to trigger by accident.

- **No shell.** rsync is spawned with `shell: false` and an argument array.
  Paths containing `$(...)`, backticks, semicolons or quotes are paths.
- **Remote args are shielded.** rsync 3.2.4 made `--secluded-args` the default;
  against anything older DiskPush passes `--protect-args` explicitly, because
  without it the remote login shell expands the remote path.
- **Mirror previews first.** A delete-enabled job cannot even be constructed
  until its dry run has been reviewed and confirmed.
- **Pass-through is checked, not blind.** `-- --delete` is refused: it would
  turn a sync into a mirror behind the preview. Everything harmless passes
  through verbatim.
- **Host keys are verified.** A changed host key blocks the connection. There
  is no global setting to turn that off.
- **No credentials on disk.** The local database holds no passwords or
  passphrases.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/install.md](docs/install.md) | Installing, updating and removing |
| [docs/getting-started.md](docs/getting-started.md) | First connection to first transfer |
| [docs/defaults.md](docs/defaults.md) | What DiskPush does when you tell it nothing |
| [docs/cli.md](docs/cli.md) | Full command grammar and exit codes |
| [docs/rsync-options.md](docs/rsync-options.md) | Every option, the flag it maps to, and its caveats |
| [docs/direct-server-to-server.md](docs/direct-server-to-server.md) | How the no-relay guarantee is implemented |
| [docs/file-browser.md](docs/file-browser.md) | Why browsing is SFTP and transfers are rsync |
| [docs/profiles.md](docs/profiles.md) | Saved, repeatable directory pairs |
| [docs/fleet.md](docs/fleet.md) | Running one command, or an upgrade, across many servers |
| [docs/security.md](docs/security.md) | Threat model and the decisions that follow from it |
| [docs/architecture.md](docs/architecture.md) | Packages, processes and boundaries |
| [docs/troubleshooting.md](docs/troubleshooting.md) | What the errors mean |
| [docs/website.md](docs/website.md) | diskpush.com architecture and deployment |

## Repository layout

```text
apps/cli            the `diskpush` command
apps/desktop        the Electron app
apps/web            diskpush.com
packages/schemas    typed option model shared by every surface
packages/rsync-core the transfer engine, with no Electron in it
packages/ssh-core   SSH sessions, SFTP browsing, host keys, preflight
packages/fleet-core one command across many servers, with no Electron in it
packages/database   the local store shared by desktop and CLI
```

`rsync-core` deliberately has no dependency on Electron or on the CLI, so the
same engine can back a daemon, an API or an MCP tool later.

## Development

```bash
pnpm install
pnpm build          # build every package
pnpm test           # unit tests plus live tests against the real rsync
pnpm typecheck
```

The live tests in `tests/live` run the actual `rsync` binary against temporary
directories. They cover the behaviour the product claims: unchanged files are
skipped, one changed file transfers alone, archive metadata survives, a mirror
previews before it deletes, a path full of shell metacharacters stays a path,
and an interrupted transfer resumes from its partial file.

## Licence

MIT.
