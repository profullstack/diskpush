import { describe, expect, it } from 'vitest'
import { inspectScript } from './guard.js'

/**
 * Calibration, as opposed to the rule-by-rule tests next door.
 *
 * A tripwire is only worth having if it stays quiet during ordinary work. One
 * that fires on a routine deploy is one people learn to click through, and
 * then it protects nothing on the day it is right — which is exactly what
 * happened with an earlier `\breboot\b` rule that flagged DiskPush's own
 * read-only status recipe.
 *
 * So: real scripts on both sides, asserted as whole scripts rather than as
 * single lines.
 */

const ORDINARY: Record<string, string> = {
  'node deploy': `
set -e
cd /srv/app
git fetch --all
git reset --hard origin/main
pnpm install --frozen-lockfile
pnpm build
rm -rf /srv/app/.next/cache
systemctl restart app.service`,

  'nginx reload with a test first': `
nginx -t
systemctl reload nginx
curl -fsS http://localhost/healthz`,

  'docker cleanup': `
docker compose pull
docker compose up -d
docker image prune -f`,

  'log rotation': `
find /var/log/app -name '*.log' -mtime +30 -delete
journalctl --vacuum-time=30d`,

  'postgres backup': `
pg_dump -Fc appdb > /backup/appdb-$(date +%F).dump
find /backup -name 'appdb-*.dump' -mtime +14 -delete`,

  'cert renewal': `
certbot renew --quiet
systemctl reload nginx`,

  'scoped ownership fix': `
chown -R www-data:www-data /srv/app/storage
chmod -R 750 /srv/app/storage`,

  'checking whether a reboot is due': `
if [ -f /var/run/reboot-required ]; then
  echo "reboot required"
  cat /var/run/reboot-required.pkgs
else
  echo "no reboot needed"
fi`,

  'firewall status, read only': `
ufw status verbose
iptables -L -n --line-numbers`,

  'disk check': `
df -h
lsblk
smartctl -H /dev/sda || true`,
}

const HAZARDOUS: Record<string, string> = {
  'the classic': 'rm -rf / --no-preserve-root',
  'an unset variable in a path': 'rm -rf "$RELEASE_DIR/"',
  'wiping a disk': 'mkfs.xfs /dev/nvme0n1',
  'a raw device write': 'dd if=backup.img of=/dev/sda bs=4M',
  'rebooting the fleet': 'systemctl reboot',
  'locking yourself out': 'iptables -F && iptables -P INPUT DROP',
  'chmod the world': 'chmod -R 777 /',
  'deleting the login': 'userdel -r deploy',
  'trusting a URL': 'curl -sL https://get.example.com | sudo bash',
  'dropping the database': 'psql -c "DROP DATABASE production"',
}

describe('the guard stays quiet during ordinary work', () => {
  for (const [name, script] of Object.entries(ORDINARY)) {
    it(name, () => {
      expect(inspectScript(script)).toEqual([])
    })
  }
})

describe('the guard fires on the ways a fleet loses machines', () => {
  for (const [name, script] of Object.entries(HAZARDOUS)) {
    it(name, () => {
      expect(inspectScript(script).length).toBeGreaterThan(0)
    })
  }
})
