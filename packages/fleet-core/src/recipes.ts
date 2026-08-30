import { FLEET_DEFAULT_TIMEOUT_SECONDS, type FleetCommand } from '@diskpush/schemas'
import { buildUpgradeScript, CHECK_SCRIPT } from './upgrade.js'

/**
 * The commands DiskPush ships.
 *
 * Kept small on purpose. These are the handful of things people reach for on
 * the first day — what needs updating, install it, is anything out of disk,
 * who is logged in — not a package library. Anything longer than a screen
 * belongs in a script file you keep in version control and run with
 * `diskpush fleet script`.
 *
 * They are listed alongside saved commands and cannot be edited in place:
 * `diskpush fleet commands copy NAME` makes an editable copy, so an upgrade
 * of DiskPush never silently changes a command someone relies on.
 */

const EPOCH = '1970-01-01T00:00:00.000Z'

function recipe(
  input: Pick<FleetCommand, 'id' | 'name' | 'description' | 'script'> & Partial<FleetCommand>,
): FleetCommand {
  return {
    interpreter: 'sh',
    sudo: false,
    workingDirectory: null,
    timeoutSeconds: FLEET_DEFAULT_TIMEOUT_SECONDS,
    targets: [],
    tags: ['builtin'],
    builtin: true,
    // Fixed rather than "now", so a recipe sorts consistently and two installs
    // of DiskPush do not disagree about when a built-in was created.
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...input,
  }
}

export const BUILTIN_RECIPES: readonly FleetCommand[] = [
  recipe({
    id: 'builtin:check-updates',
    name: 'check-updates',
    description: 'What each server needs: pending updates, reboot flag, disk, kernel. Installs nothing.',
    script: CHECK_SCRIPT,
    timeoutSeconds: 180,
  }),
  recipe({
    id: 'builtin:upgrade',
    name: 'upgrade',
    description: 'Install pending package updates. Detects the package manager per host. Never reboots.',
    script: buildUpgradeScript({ reboot: 'never' }),
    sudo: true,
    timeoutSeconds: 3600,
  }),
  recipe({
    id: 'builtin:reboot-required',
    name: 'reboot-required',
    description: 'Which servers are waiting on a reboot to finish an earlier upgrade.',
    script: `
if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
  echo "reboot required"
  [ -f /var/run/reboot-required.pkgs ] && cat /var/run/reboot-required.pkgs
elif command -v needs-restarting >/dev/null 2>&1; then
  needs-restarting -r || true
else
  echo "no reboot flag on this host"
fi`.trim(),
    timeoutSeconds: 60,
  }),
  recipe({
    id: 'builtin:disk',
    name: 'disk',
    description: 'Filesystem use on every mounted local filesystem.',
    script: "df -h -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -h",
    timeoutSeconds: 60,
  }),
  recipe({
    id: 'builtin:uptime',
    name: 'uptime',
    description: 'Load average and how long each server has been up.',
    script: 'uptime',
    interpreter: 'raw',
    timeoutSeconds: 30,
  }),
  recipe({
    id: 'builtin:who',
    name: 'who',
    description: 'Who is logged in right now.',
    script: 'who || w',
    timeoutSeconds: 30,
  }),
]

export function findRecipe(name: string): FleetCommand | null {
  return BUILTIN_RECIPES.find((entry) => entry.name === name || entry.id === name) ?? null
}

/** An editable copy of a built-in, ready to save under a new name. */
export function copyRecipe(recipeToCopy: FleetCommand, name: string): Omit<FleetCommand, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name,
    description: recipeToCopy.description,
    script: recipeToCopy.script,
    interpreter: recipeToCopy.interpreter,
    sudo: recipeToCopy.sudo,
    workingDirectory: recipeToCopy.workingDirectory,
    timeoutSeconds: recipeToCopy.timeoutSeconds,
    targets: recipeToCopy.targets,
    tags: recipeToCopy.tags.filter((tag) => tag !== 'builtin'),
    builtin: false,
  }
}
