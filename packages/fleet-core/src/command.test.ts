import { describe, expect, it } from 'vitest'
import { buildCommand, explainSudoFailure, withSudoPassword } from './command.js'

describe('buildCommand', () => {
  it('never interpolates the script into the command line', () => {
    // The whole point: a quote, a backtick or a newline in someone's script
    // must not be able to become a different command.
    const built = buildCommand({
      script: `echo "it's $(whoami)"; rm -rf /tmp/x`,
      interpreter: 'sh',
      sudo: 'off',
    })
    expect(built.command).toBe('/bin/sh -es')
    expect(built.command).not.toContain('whoami')
    expect(built.stdin).toContain('whoami')
  })

  it('feeds the script on stdin, newline-terminated', () => {
    expect(buildCommand({ script: 'uptime', interpreter: 'sh', sudo: 'off' }).stdin).toBe('uptime\n')
    expect(buildCommand({ script: 'uptime\n', interpreter: 'sh', sudo: 'off' }).stdin).toBe('uptime\n')
  })

  it('stops at the first failing command', () => {
    expect(buildCommand({ script: 'a\nb', interpreter: 'bash', sudo: 'off' }).command).toContain('-es')
  })

  it('uses sudo -n by default so a password prompt fails instead of hanging', () => {
    expect(buildCommand({ script: 'id', interpreter: 'sh', sudo: 'non-interactive' }).command).toBe('sudo -n /bin/sh -es')
  })

  it('uses sudo -S with an empty prompt when a password will be supplied', () => {
    const built = buildCommand({ script: 'id', interpreter: 'sh', sudo: 'password' })
    expect(built.command).toBe("sudo -S -p '' /bin/sh -es")
  })

  it('runs raw text unwrapped, with nothing on stdin', () => {
    const built = buildCommand({ script: 'uptime', interpreter: 'raw', sudo: 'off' })
    expect(built.command).toBe('uptime')
    expect(built.stdin).toBeUndefined()
  })

  it('quotes the working directory', () => {
    const built = buildCommand({
      script: 'ls',
      interpreter: 'sh',
      sudo: 'off',
      workingDirectory: "/srv/my app",
    })
    expect(built.command).toBe("cd '/srv/my app' && /bin/sh -es")
  })

  it('quotes environment values and puts them ahead of the interpreter', () => {
    const built = buildCommand({
      script: 'echo $TAG',
      interpreter: 'sh',
      sudo: 'off',
      env: { TAG: 'v1.2 rc1' },
    })
    expect(built.command).toBe("TAG='v1.2 rc1' /bin/sh -es")
  })

  it('refuses an environment name that no quoting could make safe', () => {
    expect(() =>
      buildCommand({ script: 'x', interpreter: 'sh', sudo: 'off', env: { 'A B': 'c' } }),
    ).toThrow(/not a usable environment variable name/)
  })

  it('shows the script inline in the display form, which is not the runnable one', () => {
    const built = buildCommand({ script: 'uptime', interpreter: 'sh', sudo: 'off' })
    expect(built.display).toContain('uptime')
    expect(built.display).toContain("<<'DISKPUSH'")
  })
})

describe('withSudoPassword', () => {
  it('puts the password on the first stdin line, ahead of the script', () => {
    const built = withSudoPassword(buildCommand({ script: 'id', interpreter: 'sh', sudo: 'password' }), 'hunter2')
    expect(built.stdin).toBe('hunter2\nid\n')
  })

  it('leaves the display form alone, so a password cannot reach a log through it', () => {
    const base = buildCommand({ script: 'id', interpreter: 'sh', sudo: 'password' })
    expect(withSudoPassword(base, 'hunter2').display).toBe(base.display)
    expect(withSudoPassword(base, 'hunter2').display).not.toContain('hunter2')
  })

  it('works for raw commands, which have no script on stdin of their own', () => {
    const built = withSudoPassword(buildCommand({ script: 'id', interpreter: 'raw', sudo: 'password' }), 'hunter2')
    expect(built.stdin).toBe('hunter2\n')
  })
})

describe('explainSudoFailure', () => {
  it('recognises every wording sudo uses for the same situation', () => {
    // These differ by sudo implementation, not by cause. Matching only the
    // first meant the one useful message never appeared on current Ubuntu,
    // which says "interactive authentication is required".
    for (const stderr of [
      'sudo: a password is required',
      'sudo: interactive authentication is required',
      'sudo: a terminal is required to read the password',
      'sudo: no askpass program specified, try setting SUDO_ASKPASS',
      'sudo: sorry, you must have a tty to run sudo',
    ]) {
      expect(explainSudoFailure(stderr), stderr).toContain('--sudo-password')
    }
  })

  it('stays out of the way of unrelated failures', () => {
    expect(explainSudoFailure('nginx: configuration file test failed')).toBeNull()
    expect(explainSudoFailure('sudo: unable to resolve host web-01')).toBeNull()
  })
})
