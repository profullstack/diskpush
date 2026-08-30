#!/bin/sh
# DiskPush installer.
#
#   curl -fsSL https://diskpush.com/install.sh | sh
#
# Installs the CLI always, and the desktop app when this machine has a desktop
# to run it on. Everything lands under your home directory: no root, no
# package manager, no system files touched. Uninstalling is `diskpush
# uninstall`, which runs a script this installer leaves behind.
#
#   sh -s -- --cli-only     never install the desktop app
#   sh -s -- --desktop      install it even with no desktop session detected
#   sh -s -- --version X    install a specific release
#   sh -s -- --prefix DIR   install root (default: ~/.local)
set -eu

REPO="profullstack/diskpush"
SITE="${DISKPUSH_SITE:-https://diskpush.com}"
PREFIX="${DISKPUSH_PREFIX:-$HOME/.local}"
VERSION="${DISKPUSH_VERSION:-}"
WANT_DESKTOP=auto

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) WANT_DESKTOP=no ;;
    --desktop)  WANT_DESKTOP=yes ;;
    --version)  VERSION="${2:?--version needs a value}"; shift ;;
    --prefix)   PREFIX="${2:?--prefix needs a value}"; shift ;;
    -h|--help)  sed -n '2,16p' "$0" 2>/dev/null || echo "See $SITE/download"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- what are we on -----------------------------------------------------------

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "unsupported operating system: $(uname -s). DiskPush supports Linux and macOS." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)." ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch()   { curl -fsSL "$1"; }
  download(){ curl -fsSL --progress-bar -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch()   { wget -qO- "$1"; }
  download(){ wget -q --show-progress -O "$2" "$1"; }
else
  fail "curl or wget is required."
fi

command -v tar >/dev/null 2>&1 || fail "tar is required."

# A desktop app needs a desktop. Over SSH into a server there is nothing to
# show it on, and downloading 100MB of Electron onto a box that will never run
# it is not a kindness.
has_desktop_session() {
  [ "$OS" = darwin ] && return 0
  [ -n "${DISPLAY:-}" ] && return 0
  [ -n "${WAYLAND_DISPLAY:-}" ] && return 0
  [ -n "${XDG_CURRENT_DESKTOP:-}" ] && return 0
  return 1
}

if [ "$WANT_DESKTOP" = auto ]; then
  if has_desktop_session; then WANT_DESKTOP=yes; else WANT_DESKTOP=no; fi
fi

# --- which release ------------------------------------------------------------

if [ -z "$VERSION" ]; then
  VERSION=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || fail "could not determine the latest version. Pass --version, or see $SITE/download"
fi

BASE="https://github.com/$REPO/releases/download/v$VERSION"
SHARE="$PREFIX/share/diskpush"
BIN="$PREFIX/bin"

say "DiskPush $VERSION"
say "  platform:  $OS-$ARCH"
say "  desktop:   $WANT_DESKTOP"
say "  prefix:    $PREFIX"
say ""

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

mkdir -p "$SHARE" "$BIN"
PATHS="$BIN/diskpush
$SHARE"
METHOD=cli-tarball

# --- the desktop app ----------------------------------------------------------

if [ "$WANT_DESKTOP" = yes ]; then
  if [ "$OS" = linux ]; then
    ASSET="DiskPush-$VERSION-linux-$ARCH.tar.gz"
    say "Downloading the desktop app..."
    download "$BASE/$ASSET" "$WORK/app.tar.gz" || fail "could not download $BASE/$ASSET"

    rm -rf "$SHARE/app"
    mkdir -p "$SHARE/app"
    # --strip-components=1: the archive holds a single top-level directory.
    tar -xzf "$WORK/app.tar.gz" -C "$SHARE/app" --strip-components=1
    METHOD=linux-app

    # The launcher ships inside the bundle, so it is versioned with the app it
    # starts. It used to be written here, and that split one behaviour across
    # two release cadences: the app came from a git tag, its launcher from
    # whatever installer happened to be deployed. They disagreed exactly once
    # and it cost a release — v0.1.3 shipped correct binaries while this script,
    # last deployed before the fix, kept writing the broken launcher over them.
    if [ -f "$SHARE/app/resources/launch.sh" ]; then
      cp "$SHARE/app/resources/launch.sh" "$SHARE/app/launch.sh"
    else
      # Bundles before 0.1.4 carry no launcher. Write one, with the same
      # decision, so pinning an old version is not a way to get the crash back.
      cat > "$SHARE/app/launch.sh" <<'FALLBACK'
#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/diskpush-desktop"

# A correctly configured SUID helper settles it. Otherwise: do not trust
# `unshare --user true`, which succeeds under a profile of its own while an
# unconfined binary is denied. The policy file is what tells the truth.
if [ -u "$here/chrome-sandbox" ]; then
  exec "$app" "$@"
fi
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ] \
  || ! unshare --user true >/dev/null 2>&1; then
  echo "diskpush: no usable Chromium sandbox here; starting without it." >&2
  exec "$app" --no-sandbox "$@"
fi
exec "$app" "$@"
FALLBACK
    fi
    chmod 0755 "$SHARE/app/launch.sh"

    # A launcher, an icon, and a menu entry. This is what a .deb would give
    # you; done by hand because doing it by hand needs no root.
    mkdir -p "$PREFIX/share/applications" "$PREFIX/share/icons/hicolor/512x512/apps"
    [ -f "$SHARE/app/resources/icon.png" ] &&
      cp "$SHARE/app/resources/icon.png" "$PREFIX/share/icons/hicolor/512x512/apps/diskpush.png"

    cat > "$PREFIX/share/applications/diskpush.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=DiskPush
GenericName=File Transfer
Comment=Push files fast. Sync only what changed.
Exec=$SHARE/app/launch.sh %U
Icon=diskpush
Terminal=false
Categories=Utility;FileTransfer;Network;
Keywords=rsync;sftp;ssh;sync;transfer;backup;
StartupWMClass=DiskPush
DESKTOP

    command -v update-desktop-database >/dev/null 2>&1 &&
      update-desktop-database "$PREFIX/share/applications" >/dev/null 2>&1 || true

    PATHS="$PATHS
$PREFIX/share/applications/diskpush.desktop
$PREFIX/share/icons/hicolor/512x512/apps/diskpush.png"

  else
    ASSET="DiskPush-$VERSION-mac-$ARCH.zip"
    say "Downloading the desktop app..."
    download "$BASE/$ASSET" "$WORK/app.zip" || fail "could not download $BASE/$ASSET"
    command -v unzip >/dev/null 2>&1 || fail "unzip is required to install the macOS app."

    APPS="$HOME/Applications"
    mkdir -p "$APPS"
    rm -rf "$APPS/DiskPush.app"
    unzip -q "$WORK/app.zip" -d "$APPS"
    METHOD=macos-app
    PATHS="$PATHS
$APPS/DiskPush.app"
  fi
fi

# --- the CLI ------------------------------------------------------------------
#
# A desktop install already contains it, and that copy runs on the Node inside
# Electron, so no system Node is needed. Without the desktop, the CLI comes as
# its own bundle and does need one.

if [ "$METHOD" = linux-app ]; then
  CLI_DIR="$SHARE/app/resources/cli"
  RUNTIME="$SHARE/app/diskpush-desktop"
elif [ "$METHOD" = macos-app ]; then
  CLI_DIR="$HOME/Applications/DiskPush.app/Contents/Resources/cli"
  RUNTIME="$HOME/Applications/DiskPush.app/Contents/MacOS/diskpush-desktop"
else
  ASSET="diskpush-cli-$VERSION-$OS-$ARCH.tar.gz"
  say "Downloading the CLI..."
  download "$BASE/$ASSET" "$WORK/cli.tar.gz" || fail "could not download $BASE/$ASSET"

  rm -rf "$SHARE/cli"
  mkdir -p "$SHARE/cli"
  tar -xzf "$WORK/cli.tar.gz" -C "$SHARE/cli" --strip-components=1
  CLI_DIR="$SHARE/cli"
  RUNTIME=""

  command -v node >/dev/null 2>&1 ||
    say "  note: no desktop app was installed, so the CLI needs Node 24 or newer. It was not found."
fi

# The shim. Written here rather than shipped, because only the installer knows
# which of the two runtimes this machine ended up with.
if [ -n "$RUNTIME" ]; then
  cat > "$BIN/diskpush" <<SHIM
#!/bin/sh
# DiskPush CLI. Runs on the Node inside the desktop app, so no system Node is
# required. Written by the installer; \`diskpush uninstall\` removes it.
ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME" "$CLI_DIR/dist/bin.js" "\$@"
SHIM
else
  cat > "$BIN/diskpush" <<SHIM
#!/bin/sh
# DiskPush CLI. Written by the installer; \`diskpush uninstall\` removes it.
command -v node >/dev/null 2>&1 || {
  echo "diskpush: node 24 or newer is required for a CLI-only install." >&2
  exit 69
}
exec node "$CLI_DIR/dist/bin.js" "\$@"
SHIM
fi
chmod 0755 "$BIN/diskpush"

# --- what was installed, and how to remove it ---------------------------------

INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DESKTOP_FLAG=false
[ "$WANT_DESKTOP" = yes ] && DESKTOP_FLAG=true

{
  printf '{\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "method": "%s",\n' "$METHOD"
  printf '  "installer": "%s/install.sh",\n' "$SITE"
  printf '  "installedAt": "%s",\n' "$INSTALLED_AT"
  printf '  "desktop": %s,\n' "$DESKTOP_FLAG"
  printf '  "paths": [\n'
  printf '%s\n' "$PATHS" | sed 's/.*/    "&",/' | sed '$ s/,$//'
  printf '  ]\n}\n'
} > "$SHARE/manifest.json"

{
  echo '#!/bin/sh'
  echo '# Removes DiskPush. Written by the installer, which knew exactly what it created.'
  echo '# Your connections, profiles and job history are NOT touched.'
  echo 'set -eu'
  printf '%s\n' "$PATHS" | sed 's|.*|rm -rf "&"|'
  echo 'echo "DiskPush removed. Configuration in ${XDG_CONFIG_HOME:-$HOME/.config}/diskpush was kept."'
} > "$SHARE/uninstall.sh"
chmod 0755 "$SHARE/uninstall.sh"

# --- report -------------------------------------------------------------------

say ""
say "Installed DiskPush $VERSION"
[ "$WANT_DESKTOP" = yes ] && say "  desktop app and CLI" || say "  CLI only (no desktop session detected)"

# rsync is the engine. Saying so now beats a confusing failure on first use.
if ! command -v rsync >/dev/null 2>&1; then
  say ""
  say "  rsync was not found, and DiskPush transfers with rsync."
  say "  Debian/Ubuntu:  sudo apt install rsync openssh-client"
  say "  macOS:          brew install rsync"
fi

case ":$PATH:" in
  *":$BIN:"*)
    say ""
    say "Try:  diskpush doctor"
    ;;
  *)
    say ""
    say "$BIN is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
    say ""
    say "Or run it directly:  $BIN/diskpush doctor"
    ;;
esac

say ""
say "Upgrade with \`diskpush update\`, remove with \`diskpush uninstall\`."
say "Docs: $SITE/docs"
