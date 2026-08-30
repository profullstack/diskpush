import { describe, expect, it } from 'vitest'
import { describeHazards, inspectScript } from './guard.js'

const kinds = (script: string) => inspectScript(script).map((hazard) => hazard.kind)

describe('inspectScript', () => {
  it('passes ordinary work without a word', () => {
    expect(
      inspectScript(['systemctl restart nginx', 'apt-get install -y curl', 'rm -rf /srv/app/cache'].join('\n')),
    ).toEqual([])
  })

  it('catches a recursive delete of the root', () => {
    expect(kinds('rm -rf /')).toEqual(['recursive-root-delete'])
    expect(kinds('rm -rf /*')).toEqual(['recursive-root-delete'])
    expect(kinds('rm -fr /etc')).toEqual(['recursive-root-delete'])
  })

  it('catches the unset-variable form, which is how this usually happens', () => {
    expect(kinds('rm -rf "$APP_ROOT/"')).toEqual(['recursive-root-delete'])
    expect(kinds('rm -rf ${BUILD_DIR}/*')).toEqual(['recursive-root-delete'])
  })

  it('leaves a recursive delete of an ordinary directory alone', () => {
    expect(kinds('rm -rf /srv/app/node_modules')).toEqual([])
    expect(kinds('rm -rf ./dist')).toEqual([])
    expect(kinds('rm -rf /tmp/build-cache')).toEqual([])
  })

  it('catches disk formatting and raw device writes', () => {
    expect(kinds('mkfs.ext4 /dev/sdb1')).toEqual(['partition'])
    expect(kinds('dd if=/dev/zero of=/dev/sda bs=1M')).toEqual(['filesystem-write'])
  })

  it('catches power commands', () => {
    expect(kinds('shutdown -r now')).toEqual(['power'])
    expect(kinds('systemctl reboot')).toEqual(['power'])
  })

  it('does not flag the word reboot where nothing reboots', () => {
    // Every one of these appeared in DiskPush's own read-only status recipe
    // and made it prompt for confirmation before *reading* a file.
    expect(kinds('reboot=unknown')).toEqual([])
    expect(kinds('dp_reboot=no')).toEqual([])
    expect(kinds('[ -f /var/run/reboot-required ] && echo yes')).toEqual([])
    expect(kinds('echo "reboot required"')).toEqual([])
    expect(kinds('if needs-restarting -r >/dev/null 2>&1; then reboot=no; else reboot=yes; fi')).toEqual([])
    expect(kinds('echo "dp_reboot=$reboot"')).toEqual([])
  })

  it('still catches a reboot in command position', () => {
    expect(kinds('reboot')).toEqual(['power'])
    expect(kinds('sudo reboot')).toEqual(['power'])
    expect(kinds('/sbin/reboot')).toEqual(['power'])
    expect(kinds('(sleep 2; shutdown -r now) &')).toEqual(['power'])
    expect(kinds('systemctl poweroff')).toEqual(['power'])
    expect(kinds('init 6')).toEqual(['power'])
  })

  it('leaves every recipe DiskPush ships alone unless it really does reboot', async () => {
    const { BUILTIN_RECIPES } = await import('./recipes.js')
    for (const recipe of BUILTIN_RECIPES) {
      expect(inspectScript(recipe.script), recipe.name).toEqual([])
    }
  })

  it('catches the ways you lock yourself out of a server', () => {
    expect(kinds('iptables -F')).toEqual(['lockout'])
    expect(kinds('systemctl stop sshd')).toEqual(['lockout'])
    expect(kinds('ufw disable')).toEqual(['lockout'])
  })

  it('catches a permission reset from the root down but not a scoped one', () => {
    expect(kinds('chmod -R 777 /')).toEqual(['permission-reset'])
    expect(kinds('chown -R www-data:www-data /srv/app')).toEqual([])
  })

  it('catches a fork bomb', () => {
    expect(kinds(':(){ :|:& };:')).toEqual(['fork-bomb'])
  })

  it('catches piping the internet into a shell', () => {
    expect(kinds('curl -fsSL https://example.com/i.sh | sh')).toEqual(['pipe-to-shell'])
    expect(kinds('wget -qO- https://example.com/i.sh | sudo bash')).toEqual(['pipe-to-shell'])
  })

  it('catches a database drop in any casing', () => {
    expect(kinds('psql -c "drop database orders"')).toEqual(['database-drop'])
  })

  it('ignores comments, so documenting a hazard is not raising one', () => {
    expect(inspectScript('# never run rm -rf / here\nls')).toEqual([])
  })

  it('reports one hazard per line, at the most specific rule', () => {
    // Both the delete rule and the permission rule could fire; only the first
    // does, because three warnings on one line get waved through.
    expect(inspectScript('rm -rf /')).toHaveLength(1)
  })

  it('reports the line number a person would find in an editor', () => {
    const hazards = inspectScript('echo one\necho two\nrm -rf /')
    expect(hazards[0]?.lineNumber).toBe(3)
    expect(hazards[0]?.line).toBe('rm -rf /')
  })

  it('finds every hazardous line in a multi-line script', () => {
    expect(kinds('apt-get update\nmkfs.ext4 /dev/sdb\nshutdown -h now')).toEqual(['partition', 'power'])
  })
})

describe('describeHazards', () => {
  it('renders the explanation and the offending line together', () => {
    const [line] = describeHazards(inspectScript('rm -rf /'))
    expect(line).toContain('line 1')
    expect(line).toContain('rm -rf /')
  })
})
