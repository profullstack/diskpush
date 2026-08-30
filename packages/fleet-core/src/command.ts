import { shellQuote } from '@diskpush/rsync-core'
import type { FleetInterpreter } from '@diskpush/schemas'

/**
 * Turning a script into one command line the remote shell will run.
 *
 * The script text is never interpolated into a command string. It goes to the
 * remote interpreter on **stdin**, and the command line only ever names the
 * interpreter. That single decision removes the whole class of bug where a
 * quote, a backtick or a newline in someone's script becomes a different
 * command than the one they wrote.
 *
 * `raw` is the exception, and it is the exception on purpose: it exists for
 * `uptime` and `systemctl status nginx`, where wrapping the text is more
 * ceremony than the job needs.
 */

export type SudoMode =
  /** Not root. */
  | 'off'
  /**
   * `sudo -n`. Fails immediately when a password is needed rather than
   * hanging forever on a prompt no one can see — the default, because a fleet
   * run that stalls silently on host seven is worse than one that fails.
   */
  | 'non-interactive'
  /** `sudo -S`, reading the password from stdin. Held in memory for the run only. */
  | 'password'

export type BuildOptions = {
  script: string
  interpreter: FleetInterpreter
  sudo: SudoMode
  workingDirectory?: string | null
  /** Extra environment, applied before the script runs. */
  env?: Readonly<Record<string, string>>
  /**
   * Stop at the first failing command. On by default, because a three-line
   * deploy step that carries on after step one failed is not what anyone
   * writing it assumed.
   *
   * Off for a *probe*, where commands are expected to fail: `grep -c` exits 1
   * when it counts zero, and under `-e` that ends the script and makes a
   * perfectly healthy server look unreachable.
   */
  failFast?: boolean
}

export type BuiltCommand = {
  /** What to hand to `SshSession.execStream`. */
  command: string
  /** What to write to the remote process's stdin, if anything. */
  stdin: string | undefined
  /**
   * A human-readable one-liner for logs, previews and `--print-command`.
   * Not runnable, and not meant to be: it shows the script inline where the
   * real invocation pipes it.
   */
  display: string
}

/** `sh` and `bash` only. Anything else is a way to spell a command injection. */
const INTERPRETER_BINARY: Record<Exclude<FleetInterpreter, 'raw'>, string> = {
  sh: '/bin/sh',
  bash: 'bash',
}

/**
 * `NAME=value` prefixes, quoted.
 *
 * Names are validated rather than escaped: there is no quoting that makes a
 * variable name with a space in it mean anything, so a bad name is a mistake
 * to report, not one to work around.
 */
function envPrefix(env: Readonly<Record<string, string>> | undefined): string {
  if (!env) return ''
  const parts: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`${JSON.stringify(name)} is not a usable environment variable name.`)
    }
    parts.push(`${name}=${shellQuote(value)}`)
  }
  return parts.length > 0 ? `${parts.join(' ')} ` : ''
}

function sudoPrefix(mode: SudoMode): string {
  switch (mode) {
    case 'off':
      return ''
    case 'non-interactive':
      return 'sudo -n '
    case 'password':
      // `-p ''` suppresses the prompt text, which would otherwise land in
      // stderr and be reported as output the command produced.
      return "sudo -S -p '' "
  }
}

export function buildCommand(options: BuildOptions): BuiltCommand {
  const { script, interpreter, sudo } = options
  const cd = options.workingDirectory ? `cd ${shellQuote(options.workingDirectory)} && ` : ''
  const env = envPrefix(options.env)

  if (interpreter === 'raw') {
    const command = `${cd}${env}${sudoPrefix(sudo)}${script}`
    // Nothing on stdin: `withSudoPassword` is what puts a password there, and
    // only when one was actually collected.
    return { command, stdin: undefined, display: command }
  }

  const binary = INTERPRETER_BINARY[interpreter]
  // `-s` makes the interpreter read the script from stdin while still
  // accepting arguments; `-e` stops at the first failing command.
  const flags = options.failFast === false ? '-s' : '-es'
  const inner = `${env}${binary} ${flags}`
  const command = `${cd}${sudoPrefix(sudo)}${inner}`

  return {
    command,
    stdin: script.endsWith('\n') ? script : `${script}\n`,
    display: `${cd}${sudoPrefix(sudo)}${env}${binary} ${flags}  <<'DISKPUSH'\n${script.trimEnd()}\nDISKPUSH`,
  }
}

/**
 * Prepends the sudo password to whatever the process reads first.
 *
 * `sudo -S` takes the password as the first line on stdin and hands the rest
 * to the command it runs, so a shell script piped in behind it still arrives
 * intact. Kept separate from `buildCommand` so the password never travels
 * through the same object that gets logged.
 */
export function withSudoPassword(built: BuiltCommand, password: string): BuiltCommand {
  return { ...built, stdin: `${password}\n${built.stdin ?? ''}` }
}

/**
 * The message for a `sudo -n` refusal.
 *
 * sudo's own wording is accurate and tells nobody what to do about it, and
 * this is the single most common way a first fleet run fails.
 *
 * There are several wordings, and they differ by implementation rather than
 * by cause: classic sudo says "a password is required", newer builds and
 * sudo-rs say "interactive authentication is required", and a build without
 * an askpass helper says so instead. Matching only the first meant the one
 * message worth showing never appeared on a current Ubuntu.
 */
const SUDO_NEEDS_AUTH =
  /sudo:.*(password is required|interactive authentication is required|a terminal is required|no askpass program|must have a tty)/i

export function explainSudoFailure(stderr: string): string | null {
  if (!SUDO_NEEDS_AUTH.test(stderr)) return null
  return (
    'sudo on this server wants a password. Re-run with --sudo-password to be asked for it once, ' +
    'or give the login NOPASSWD for the commands you run here.'
  )
}
