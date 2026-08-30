#!/bin/bash
# Chooses a sandbox before starting DiskPush.
#
# Chromium needs one of two: the namespace sandbox, which needs unprivileged
# user namespaces, or the SUID helper, which needs chrome-sandbox owned by root
# with mode 4755 and so is unavailable to an install without root. With
# neither, it aborts on launch with SIGTRAP:
#
#   FATAL:setuid_sandbox_host.cc(163) The SUID sandbox helper binary was found,
#   but is not configured correctly.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/diskpush-desktop"

sandbox_unavailable() {
  # A correctly configured SUID helper settles it; a .deb install sets this up.
  [ -u "$here/chrome-sandbox" ] && return 1

  # Do NOT trust `unshare --user true` alone. Ubuntu 24.04+ restricts
  # unprivileged user namespaces through AppArmor but ships a profile for
  # unshare itself, so the probe succeeds while an unconfined binary like this
  # one is still denied. Reading the policy directly is what tells the truth.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    return 0
  fi

  unshare --user true >/dev/null 2>&1 && return 1
  return 0
}

if sandbox_unavailable; then
  echo "diskpush: this kernel restricts unprivileged user namespaces, and the SUID" >&2
  echo "          sandbox helper needs root to configure, which this install does" >&2
  echo "          not have. Starting without Chromium's sandbox." >&2
  echo "          For a sandboxed install use the .deb: https://diskpush.com/download" >&2
  exec "$app" --no-sandbox "$@"
fi

# The checks above are the best that can be known in advance, and they have
# been wrong before. If the app dies immediately complaining about the sandbox,
# believe it over the probe rather than leaving the user with a core dump.
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT INT TERM
if "$app" "$@" 2> >(tee "$errors" >&2); then
  exit 0
fi
status=$?

if grep -qE 'sandbox|SUID' "$errors" 2>/dev/null; then
  echo "diskpush: the sandbox was unavailable after all; restarting without it." >&2
  exec "$app" --no-sandbox "$@"
fi
exit $status
