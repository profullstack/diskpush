# Installing

```sh
curl -fsSL https://diskpush.com/install.sh | sh
```

Installs the CLI, and the desktop app when the machine has a desktop session
to run it on.

Everything lands under your home directory. No root, no package manager, no
system files touched — a script piped into a shell should not be asking for
sudo, and this one never does.

## Options

```sh
curl -fsSL https://diskpush.com/install.sh | sh -s -- --cli-only
```

| Option | Effect |
| --- | --- |
| `--cli-only` | Never install the desktop app. |
| `--desktop` | Install it even where no desktop session was detected. |
| `--version X` | Install a specific release instead of the latest. |
| `--prefix DIR` | Install root. Default `~/.local`. |

## What it decides, and why

**Whether to install the desktop app.** On macOS, always. On Linux, when
`DISPLAY`, `WAYLAND_DISPLAY` or `XDG_CURRENT_DESKTOP` is set. Over SSH into a
server there is nothing to show a window on, and downloading 100MB of Electron
onto a machine that will never run it is not a kindness. `--desktop` overrides
this, for the case where you are setting up a machine you will later sit at.

**Where the CLI's runtime comes from.** A desktop install carries the CLI
inside the app bundle and runs it on the Node that ships with Electron, so
`diskpush` works on the command line with no system Node at all. A CLI-only
install is a plain Node program and needs Node 24 or newer.

## What it writes

```text
~/.local/bin/diskpush                              the CLI
~/.local/share/diskpush/app/                       the desktop app (if installed)
~/.local/share/diskpush/cli/                       the CLI bundle (CLI-only installs)
~/.local/share/diskpush/manifest.json              what was installed
~/.local/share/diskpush/uninstall.sh               how to remove it
~/.local/share/applications/diskpush.desktop       the menu entry
~/.local/share/icons/hicolor/512x512/apps/         the icon
```

Nothing outside your home directory.

## Updating and removing

```sh
diskpush update      # upgrade in place
diskpush uninstall   # remove it
```

Both read the manifest the installer wrote rather than guessing. `uninstall`
runs the script left beside it, so removal is exact and works with no network
— a command that needs the internet to uninstall itself is one you cannot get
rid of on a plane.

Neither touches your configuration. Connections, profiles and job history live
in `~/.config/diskpush` and survive both, so reinstalling picks up where you
left off. Delete that directory yourself if you want it gone.

## Manual installation

Piping a script into a shell is a real decision. The script is short enough to
read first — it is [`scripts/install.sh`](https://github.com/profullstack/diskpush/blob/main/scripts/install.sh)
in the repository, and the URL serves that same file.

If you would rather not:

| Artifact | Notes |
| --- | --- |
| `DiskPush-<version>-linux-amd64.deb` | Debian/Ubuntu. Menu entry included, and it carries the fix for electron-builder's chrome-sandbox permissions on Ubuntu 24.04+. Needs root. |
| `DiskPush-<version>-linux-x86_64.AppImage` | One file, no install. `chmod +x` and run. |
| `DiskPush-<version>-linux-x64.tar.gz` | The app as a directory. What the installer uses. |
| `diskpush-cli-<version>-linux-x64.tar.gz` | CLI only. Needs Node 24+. |

All are on the [releases page](https://github.com/profullstack/diskpush/releases),
with a `SHA256SUMS` to check them against.

## Requirements

DiskPush drives rsync and SSH rather than reimplementing them:

```sh
sudo apt install rsync openssh-client   # Debian / Ubuntu
brew install rsync                      # macOS, for a modern version
```

`diskpush doctor` reports what it found.

## Platforms

Linux x86_64 today. macOS and arm64 builds need a runner that can produce
them; the CLI builds on both. Windows is not supported yet — see
[rsync-options.md](rsync-options.md) for why native Windows rsync is not
equivalent.
