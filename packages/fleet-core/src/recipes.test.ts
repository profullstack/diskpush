import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BUILTIN_RECIPES, copyRecipe, findRecipe } from './recipes.js'
import { buildCommand } from './command.js'

/**
 * The shipped recipes, run for real.
 *
 * Both bugs this file exists for were invisible to a reading of the code and
 * obvious the moment a recipe was actually executed under the shell a fleet
 * run uses:
 *
 *  - `check-updates` is a *probe*: `grep -c` exits 1 when it counts zero
 *    updates, so under `sh -e` the script ended early and a healthy, fully
 *    patched server reported as unreachable.
 *  - `reboot-required` ended its first branch with `[ -f pkgs ] && cat pkgs`,
 *    whose status is the `if`'s status — so a server that genuinely needed a
 *    reboot but had no package list reported as *failed*.
 */

/** Runs a script the way `runFleet` does: piped to the interpreter on stdin. */
function runScript(binary: string, script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(binary, ['-es'], { timeout: 60_000, maxBuffer: 8_000_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout, stderr })
    })
    // `execFile` has no `input` option — the script has to be written and the
    // stream closed, or `sh -es` waits on stdin until the timeout.
    child.stdin?.end(`${script}\n`)
  })
}

describe('the recipes DiskPush ships', () => {
  it('all have a name, a description and something to run', () => {
    for (const recipe of BUILTIN_RECIPES) {
      expect(recipe.name, recipe.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(recipe.description.length, recipe.name).toBeGreaterThan(10)
      expect(recipe.script.trim().length, recipe.name).toBeGreaterThan(0)
      expect(recipe.builtin, recipe.name).toBe(true)
    }
  })

  it('state every field, since nothing parses them through the schema', () => {
    // These are plain literals typed as FleetCommand. A field the schema
    // merely defaults is `undefined` here, and reached the desktop as
    // `setConcurrency(undefined)`.
    for (const entry of BUILTIN_RECIPES) {
      expect(entry.concurrency, entry.name).toBeGreaterThan(0)
      expect(['continue', 'stop'], entry.name).toContain(entry.onFailure)
      expect(entry.timeoutSeconds, entry.name).toBeGreaterThan(0)
      expect(entry.workingDirectory, entry.name).toBeNull()
      expect(Array.isArray(entry.targets), entry.name).toBe(true)
    }
  })

  it('have unique names, so one cannot shadow another', () => {
    const names = BUILTIN_RECIPES.map((recipe) => recipe.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('are found by name and by id', () => {
    expect(findRecipe('uptime')?.name).toBe('uptime')
    expect(findRecipe('builtin:uptime')?.name).toBe('uptime')
    expect(findRecipe('nope')).toBeNull()
  })

  it('needs root only where it installs something', () => {
    // A status command that asks for sudo is a status command people stop
    // running, so only `upgrade` may want it.
    for (const recipe of BUILTIN_RECIPES) {
      if (recipe.name !== 'upgrade') expect(recipe.sudo, recipe.name).toBe(false)
    }
    expect(findRecipe('upgrade')?.sudo).toBe(true)
  })
})

describe('copyRecipe', () => {
  it('produces something editable, under a new name, without the builtin tag', () => {
    const copy = copyRecipe(findRecipe('upgrade')!, 'my-upgrade')
    expect(copy.name).toBe('my-upgrade')
    expect(copy.builtin).toBe(false)
    expect(copy.tags).not.toContain('builtin')
    expect(copy.script).toBe(findRecipe('upgrade')!.script)
    // A copy that lost the pacing would run the same script at a different
    // speed, which is the one thing a copy must not do.
    expect(copy.concurrency).toBe(findRecipe('upgrade')!.concurrency)
    expect(copy.onFailure).toBe(findRecipe('upgrade')!.onFailure)
  })
})

describe('every read-only recipe survives the shell a fleet run uses', () => {
  // `upgrade` is excluded because it installs packages; its structure is
  // asserted in upgrade.test.ts instead.
  const readOnly = BUILTIN_RECIPES.filter((recipe) => recipe.name !== 'upgrade')

  for (const recipe of readOnly) {
    it(`${recipe.name} exits 0 on a healthy machine`, async () => {
      const binary = recipe.interpreter === 'bash' ? 'bash' : '/bin/sh'
      const { code, stderr } = await runScript(binary, recipe.script)
      expect(code, `${recipe.name} stderr: ${stderr}`).toBe(0)
    }, 90_000)
  }
})

describe('check-updates', () => {
  it('declares its own tolerance for failing commands', () => {
    // In the script, not in the caller: that is what keeps it true after
    // someone copies it, runs it through `fleet script`, or picks it from the
    // desktop's recipe list, none of which pass a flag.
    expect(findRecipe('check-updates')!.script).toMatch(/^set \+e$|^set \+e\s/m)
  })

  it('reports every field the check table renders', async () => {
    const { code, stdout } = await runScript('/bin/sh', findRecipe('check-updates')!.script)
    expect(code).toBe(0)
    for (const key of ['dp_pm=', 'dp_os=', 'dp_kernel=', 'dp_reboot=']) {
      expect(stdout, `missing ${key}`).toContain(key)
    }
  }, 90_000)
})

describe('no status recipe is ever silent', () => {
  /*
   * A status command that prints nothing is indistinguishable from a broken
   * one. `who || w` shipped exactly that: `who` reads utmp, which is routinely
   * empty on a systemd host with pty-less SSH sessions, and it exits 0 either
   * way — so `||` never reached the fallback and the recipe reported nothing
   * on a machine with users logged into it.
   */
  const reporting = BUILTIN_RECIPES.filter((entry) => entry.name !== 'upgrade')

  for (const entry of reporting) {
    it(`${entry.name} says something`, async () => {
      const binary = entry.interpreter === 'bash' ? 'bash' : '/bin/sh'
      const { code, stdout } = await runScript(binary, entry.script)
      expect(code).toBe(0)
      expect(stdout.trim(), `${entry.name} produced no output`).not.toBe('')
    }, 90_000)
  }
})

describe('who', () => {
  it('falls back on empty output, not on a non-zero exit', () => {
    // `||` cannot see the difference, and the difference is the whole bug.
    const script = findRecipe('who')!.script
    expect(script).not.toMatch(/who\s*\|\|/)
    expect(script).toMatch(/-z "\$found"/)
  })

  it('states that nobody is logged in rather than printing nothing', () => {
    expect(findRecipe('who')!.script).toMatch(/no interactive logins/)
  })
})

describe('reboot-required', () => {
  it('succeeds when a reboot is needed but no package list exists', async () => {
    // The exact case the old `[ -f pkgs ] && cat pkgs` form got wrong: its
    // status was the `if`'s status, so the answer became a failure.
    const script = findRecipe('reboot-required')!.script.replaceAll(
      '/var/run/reboot-required',
      '/etc/hostname', // exists, so the first branch is taken
    )
    const { code, stdout } = await runScript('/bin/sh', script)
    expect(code).toBe(0)
    expect(stdout).toContain('reboot required')
  })
})

describe('the interpreter a recipe asks for', () => {
  it('is one the command builder can actually run', () => {
    for (const recipe of BUILTIN_RECIPES) {
      expect(() =>
        buildCommand({ script: recipe.script, interpreter: recipe.interpreter, sudo: 'off' }),
      ).not.toThrow()
    }
  })
})
