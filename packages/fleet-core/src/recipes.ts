import { FLEET_DEFAULT_CONCURRENCY, FLEET_DEFAULT_TIMEOUT_SECONDS, type FleetCommand } from '@diskpush/schemas'
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
    /*
     * Stated, not inherited. These objects are plain literals typed as
     * FleetCommand — nothing parses them through the schema, so a field the
     * schema defaults is simply `undefined` here. That reached the desktop as
     * `setConcurrency(undefined)` and broke the input.
     */
    concurrency: FLEET_DEFAULT_CONCURRENCY,
    onFailure: 'continue',
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
    /*
     * Every branch ends in something that succeeds.
     *
     * `[ -f pkgs ] && cat pkgs` as the last statement of the `then` block
     * returns 1 when the file is absent, which is the `if`'s status, which
     * under `sh -e` exits the script — so a server that genuinely needs a
     * reboot but has no package list reported as *failed*. The `|| true` is
     * what makes the answer the exit code rather than the accident.
     */
    script: `
if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
  echo "reboot required"
  cat /var/run/reboot-required.pkgs 2>/dev/null || true
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
    /*
     * `who || w` was wrong, and wrong in a way that looked fine.
     *
     * `who` reads utmp, which on a systemd host with pty-less SSH sessions is
     * routinely empty while people are very much logged in — and it exits 0
     * either way. So `||` never reached `w`, and the recipe reported an empty
     * result on a machine with users on it. The failure mode here is empty
     * output, not a non-zero exit, and `||` cannot see the difference.
     *
     * It also ends by saying so out loud. A status command that prints
     * nothing is indistinguishable from a broken one, which is exactly how
     * this got reported.
     */
    script: `
found=$(who 2>/dev/null)
[ -z "$found" ] && found=$(w -h 2>/dev/null)
if [ -n "$found" ]; then
  printf '%s\n' "$found"
else
  echo "no interactive logins on this host"
fi`.trim(),
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
    // A copy that lost the pacing would run the same script at a different
    // speed, which is the one thing a copy must not do.
    concurrency: recipeToCopy.concurrency,
    onFailure: recipeToCopy.onFailure,
    targets: recipeToCopy.targets,
    tags: recipeToCopy.tags.filter((tag) => tag !== 'builtin'),
    builtin: false,
  }
}
