import { describe, expect, it } from 'vitest'
import {
  buildUpgradeScript,
  CHECK_SCRIPT,
  isUpToDate,
  parseCheckOutput,
  rebootPendingFrom,
  upgradeCommandFor,
} from './upgrade.js'

describe('parseCheckOutput', () => {
  it('reads a full report', () => {
    const report = parseCheckOutput(
      [
        'dp_pm=apt',
        'dp_os=Ubuntu 24.04.1 LTS',
        'dp_kernel=6.8.0-45-generic',
        'dp_uptime=864000',
        'dp_disk=61',
        'dp_updates=14',
        'dp_security=3',
        'dp_reboot=yes',
      ].join('\n'),
    )
    expect(report).toMatchObject({
      packageManager: 'apt',
      os: 'Ubuntu 24.04.1 LTS',
      kernel: '6.8.0-45-generic',
      uptimeSeconds: 864000,
      diskUsedPercent: 61,
      updates: 14,
      securityUpdates: 3,
      rebootRequired: true,
    })
  })

  it('ignores a login banner rather than treating the host as unreadable', () => {
    const report = parseCheckOutput('*** System restart required ***\nWelcome to prod!\ndp_pm=apt\ndp_updates=0')
    expect(report.packageManager).toBe('apt')
    expect(report.updates).toBe(0)
  })

  it('keeps "unknown" and "zero" apart, because they mean different things', () => {
    // A package manager that cannot count security updates separately reports
    // nothing; that must not read as "no security updates pending".
    const report = parseCheckOutput('dp_pm=apk\ndp_updates=0')
    expect(report.updates).toBe(0)
    expect(report.securityUpdates).toBeNull()
  })

  it('reports an unknown reboot state rather than guessing no', () => {
    expect(parseCheckOutput('dp_reboot=unknown').rebootRequired).toBeNull()
    expect(parseCheckOutput('dp_reboot=no').rebootRequired).toBe(false)
  })

  it('falls back to unknown for a package manager it does not drive', () => {
    expect(parseCheckOutput('dp_pm=portage').packageManager).toBe('unknown')
  })

  it('rejects a nonsense disk percentage instead of reporting it', () => {
    expect(parseCheckOutput('dp_disk=4000').diskUsedPercent).toBeNull()
  })

  it('survives empty output', () => {
    expect(parseCheckOutput('')).toMatchObject({ updates: null, rebootRequired: null })
  })
})

describe('upgradeCommandFor', () => {
  it('is non-interactive for every package manager it drives', () => {
    for (const manager of ['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'brew', 'pkg'] as const) {
      const command = upgradeCommandFor(manager)
      expect(command, manager).not.toBeNull()
      expect(command, manager).not.toMatch(/\s-i\b/)
    }
  })

  it('keeps the installed config file when apt asks, so a fleet run cannot stall on a prompt', () => {
    expect(upgradeCommandFor('apt')).toContain('--force-confold')
    expect(upgradeCommandFor('apt')).toContain('DEBIAN_FRONTEND=noninteractive')
  })

  it('does not remove packages: upgrade, never dist-upgrade or autoremove', () => {
    for (const manager of ['apt', 'dnf', 'yum', 'zypper', 'apk', 'pkg'] as const) {
      expect(upgradeCommandFor(manager), manager).not.toMatch(/autoremove|dist-upgrade/)
    }
  })

  it('has nothing to offer for an unrecognised system', () => {
    expect(upgradeCommandFor('unknown')).toBeNull()
  })
})

describe('buildUpgradeScript', () => {
  it('detects the package manager on the host, so one script covers a mixed fleet', () => {
    const script = buildUpgradeScript()
    expect(script).toContain('command -v apt-get')
    expect(script).toContain('command -v pacman')
    expect(script).toContain('case "$pm" in')
  })

  it('exits rather than guessing when nothing is recognised', () => {
    expect(buildUpgradeScript()).toContain('no supported package manager')
  })

  it('never reboots by default', () => {
    const script = buildUpgradeScript({ reboot: 'never' })
    expect(script).not.toContain('shutdown -r')
    expect(script).toContain('needs a reboot to finish')
  })

  it('reboots only where the host says it is needed under if-needed', () => {
    const script = buildUpgradeScript({ reboot: 'if-needed' })
    expect(script).toContain('shutdown -r now')
    expect(script).toContain('if [ "$dp_reboot" = "yes" ]')
  })

  it('reboots unconditionally under always', () => {
    const script = buildUpgradeScript({ reboot: 'always' })
    expect(script).toContain('diskpush: rebooting.')
  })

  it('stops on the first failing step', () => {
    expect(buildUpgradeScript()).toMatch(/^set -e/m)
  })
})

describe('rebootPendingFrom', () => {
  it('reads the marker the upgrade script echoes', () => {
    expect(rebootPendingFrom('installing...\ndp_reboot=yes\ndone')).toBe(true)
    expect(rebootPendingFrom('dp_reboot=no')).toBe(false)
  })

  it('is unknown when the script never got that far', () => {
    expect(rebootPendingFrom('apt-get: command not found')).toBeNull()
  })
})

describe('CHECK_SCRIPT', () => {
  it('emits only dp_ lines for the parser to read', () => {
    for (const key of ['dp_pm=', 'dp_os=', 'dp_kernel=', 'dp_reboot=']) {
      expect(CHECK_SCRIPT).toContain(key)
    }
  })

  it('installs nothing and takes no lock', () => {
    // `apt-get update` would rewrite the package lists; a status command may
    // not do that behind someone's back.
    expect(CHECK_SCRIPT).not.toMatch(/apt-get update/)
    expect(CHECK_SCRIPT).toContain('Debug::NoLocking=true')
  })

  it('leaves no unexpanded JavaScript template markers in the shell it ships', () => {
    // `${os:-unknown}` in a template literal is a JS interpolation unless it
    // is escaped; getting that wrong ships a script with an empty hole in it.
    expect(CHECK_SCRIPT).toContain('${os:-unknown}')
    expect(CHECK_SCRIPT).not.toContain('undefined')
  })
})
