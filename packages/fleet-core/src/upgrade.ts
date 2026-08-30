import type { HostUpdateReport, PackageManager } from '@diskpush/schemas'

/**
 * Server upgrades, across a fleet of servers that are not all the same.
 *
 * Two operations, kept apart because they answer different questions:
 *
 *   check    what does each server need? Nothing is installed, nothing is
 *            restarted, and it is safe to run at any hour.
 *   upgrade  install it.
 *
 * Everything is driven from one probe script per host rather than a matrix of
 * per-distro commands issued from here, because the only machine that knows
 * which package manager a server has is that server.
 */

/**
 * Detection, in the order that avoids the wrong answer.
 *
 * `apt-get` before `dnf` and `yum` because some Debian derivatives ship
 * compatibility shims; `dnf` before `yum` because on modern Fedora and RHEL
 * `yum` is a symlink to `dnf` and driving it through the shim loses output.
 */
const DETECT = `
if command -v apt-get >/dev/null 2>&1; then echo apt
elif command -v dnf >/dev/null 2>&1; then echo dnf
elif command -v yum >/dev/null 2>&1; then echo yum
elif command -v zypper >/dev/null 2>&1; then echo zypper
elif command -v pacman >/dev/null 2>&1; then echo pacman
elif command -v apk >/dev/null 2>&1; then echo apk
elif command -v pkg >/dev/null 2>&1; then echo pkg
elif command -v brew >/dev/null 2>&1; then echo brew
else echo unknown
fi`.trim()

/**
 * The check script.
 *
 * Emits `dp_key=value` lines and nothing else, so the parser never has to
 * guess at localised package-manager prose. Every counting step is allowed to
 * fail: a server whose repositories are unreachable should report an unknown
 * update count, not fail the whole sweep.
 *
 * Counting is deliberately read-only. `apt-get update` would give a more
 * current answer and also takes locks and rewrites lists, which is not
 * something a status command may do behind someone's back.
 */
export const CHECK_SCRIPT = `
pm=$(${DETECT})
echo "dp_pm=$pm"

os=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || sw_vers -productName 2>/dev/null || uname -s )
echo "dp_os=\${os:-unknown}"
echo "dp_kernel=$(uname -r 2>/dev/null || echo unknown)"

if [ -r /proc/uptime ]; then
  echo "dp_uptime=$(cut -d. -f1 /proc/uptime)"
fi

# Root filesystem use. The usual reason an upgrade fails halfway is /boot or
# / filling up, which is worth knowing before rather than after.
disk=$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
[ -n "$disk" ] && echo "dp_disk=$disk"

updates=""
security=""
case "$pm" in
  apt)
    updates=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -c '^Inst ')
    security=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep '^Inst ' | grep -ci 'security')
    ;;
  dnf|yum)
    # check-update exits 100 when updates exist and 0 when none do, so its
    # status is not an error to trap.
    updates=$($pm -q check-update 2>/dev/null | grep -cE '^[a-zA-Z0-9]\\S*\\s+\\S+\\s+\\S+$')
    security=$($pm -q updateinfo list security 2>/dev/null | grep -cE '^[A-Z]+-' )
    ;;
  zypper)
    updates=$(zypper --non-interactive --quiet list-updates 2>/dev/null | grep -c '^v |')
    security=$(zypper --non-interactive --quiet list-patches --category security 2>/dev/null | grep -c 'security')
    ;;
  pacman)
    if command -v checkupdates >/dev/null 2>&1; then
      updates=$(checkupdates 2>/dev/null | wc -l)
    else
      updates=$(pacman -Qu 2>/dev/null | wc -l)
    fi
    ;;
  apk)
    updates=$(apk version -l '<' 2>/dev/null | tail -n +2 | wc -l)
    ;;
  brew)
    updates=$(brew outdated --quiet 2>/dev/null | wc -l)
    ;;
  pkg)
    updates=$(pkg version -vRL= 2>/dev/null | wc -l)
    ;;
esac
[ -n "$updates" ] && echo "dp_updates=$updates"
[ -n "$security" ] && echo "dp_security=$security"

reboot=unknown
if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
  reboot=yes
elif command -v needs-restarting >/dev/null 2>&1; then
  if needs-restarting -r >/dev/null 2>&1; then reboot=no; else reboot=yes; fi
elif command -v zypper >/dev/null 2>&1 && zypper --non-interactive needs-rebooting >/dev/null 2>&1; then
  reboot=no
elif [ "$pm" = "apt" ] || [ "$pm" = "apk" ]; then
  # No marker file on a system that would have written one means no reboot.
  reboot=no
fi
echo "dp_reboot=$reboot"
`.trim()

/**
 * The upgrade command for one package manager.
 *
 * Every one of these is non-interactive and answers "keep the installed
 * config file" where the question comes up, because a fleet upgrade that
 * stops on a conffile prompt on host four is a fleet upgrade that has already
 * failed. Nothing here removes packages: `autoremove` and `dist-upgrade` can
 * both take away something that is running, so they are not the default.
 */
export function upgradeCommandFor(manager: PackageManager): string | null {
  switch (manager) {
    case 'apt':
      return [
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -qq',
        'apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade',
      ].join('\n')
    case 'dnf':
      return 'dnf -y --refresh upgrade'
    case 'yum':
      return 'yum -y update'
    case 'zypper':
      return 'zypper --non-interactive refresh && zypper --non-interactive update --auto-agree-with-licenses'
    case 'pacman':
      return 'pacman -Syu --noconfirm'
    case 'apk':
      return 'apk update && apk upgrade'
    case 'brew':
      return 'brew update && brew upgrade'
    case 'pkg':
      return 'pkg update && pkg upgrade -y'
    case 'unknown':
      return null
  }
}

/**
 * The script an upgrade actually runs.
 *
 * Detection happens on the host, inside the same script, so one command works
 * across a fleet that mixes Debian, Alma and Alpine. That is the whole point:
 * the alternative is a check pass, a per-host branch here, and a second
 * connection, which is three ways to get out of step with reality.
 */
export function buildUpgradeScript(options: { reboot: 'never' | 'if-needed' | 'always' } = { reboot: 'never' }): string {
  const cases = (['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'brew', 'pkg'] as const)
    .map((manager) => `  ${manager})\n${indent(upgradeCommandFor(manager) ?? 'exit 1', 4)}\n    ;;`)
    .join('\n')

  const reboot =
    options.reboot === 'never'
      ? `if [ "$dp_reboot" = "yes" ]; then\n  echo "diskpush: this server needs a reboot to finish."\nfi`
      : options.reboot === 'always'
        ? `echo "diskpush: rebooting."\n(sleep 2; shutdown -r now) >/dev/null 2>&1 &`
        : `if [ "$dp_reboot" = "yes" ]; then\n  echo "diskpush: reboot required, rebooting."\n  (sleep 2; shutdown -r now) >/dev/null 2>&1 &\nelse\n  echo "diskpush: no reboot needed."\nfi`

  return `
set -e
pm=$(${DETECT})
echo "diskpush: package manager is $pm"
if [ "$pm" = "unknown" ]; then
  echo "diskpush: no supported package manager found on this host." >&2
  exit 69
fi

case "$pm" in
${cases}
esac

dp_reboot=no
if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
  dp_reboot=yes
elif command -v needs-restarting >/dev/null 2>&1; then
  needs-restarting -r >/dev/null 2>&1 || dp_reboot=yes
fi
echo "dp_reboot=$dp_reboot"

${reboot}
`.trim()
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n')
}

/**
 * Reads the `dp_key=value` lines out of a check run.
 *
 * Anything else on stdout is ignored rather than treated as an error: an
 * `/etc/profile` that prints a banner on every login is common, and it is not
 * a reason to report a server as unreadable.
 */
export function parseCheckOutput(stdout: string): Partial<HostUpdateReport> {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const match = /^dp_([a-z]+)=(.*)$/.exec(line.trim())
    if (match) values.set(match[1]!, match[2]!.trim())
  }

  const report: Partial<HostUpdateReport> = {}
  const manager = values.get('pm')
  if (manager) report.packageManager = asPackageManager(manager)

  const os = values.get('os')
  if (os && os !== 'unknown') report.os = os

  const kernel = values.get('kernel')
  if (kernel && kernel !== 'unknown') report.kernel = kernel

  report.uptimeSeconds = nonNegativeInteger(values.get('uptime'))
  report.updates = nonNegativeInteger(values.get('updates'))
  report.securityUpdates = nonNegativeInteger(values.get('security'))

  const disk = nonNegativeInteger(values.get('disk'))
  report.diskUsedPercent = disk !== null && disk <= 100 ? disk : null

  const reboot = values.get('reboot')
  report.rebootRequired = reboot === 'yes' ? true : reboot === 'no' ? false : null

  return report
}

function asPackageManager(value: string): PackageManager {
  const known: readonly PackageManager[] = ['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'brew', 'pkg']
  return known.includes(value as PackageManager) ? (value as PackageManager) : 'unknown'
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Whether an upgrade run says the server still needs a reboot.
 *
 * The upgrade script echoes this rather than leaving it to be inferred from a
 * package list, so the answer survives a package manager changing how it
 * words things.
 */
export function rebootPendingFrom(stdout: string): boolean | null {
  const match = /^dp_reboot=(yes|no)$/m.exec(stdout)
  if (!match) return null
  return match[1] === 'yes'
}

/** True when nothing on this host needs installing. */
export function isUpToDate(report: Pick<HostUpdateReport, 'updates'>): boolean {
  return report.updates === 0
}
