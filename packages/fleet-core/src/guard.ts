/**
 * The tripwire in front of a fan-out.
 *
 * A mistyped command on one server is an afternoon. The same command on forty
 * is the company. DiskPush already refuses to delete on the destination side
 * of a transfer without showing you the list first, and this is the same idea
 * one layer up: a script that matches a known way to lose a machine does not
 * run until someone says so explicitly.
 *
 * What this is not: a sandbox, a parser, or a safety guarantee. A shell is
 * Turing-complete and anything here can be written around in ten seconds. It
 * catches the accident, not the adversary — and the accident is what actually
 * happens.
 */

export type HazardKind =
  | 'recursive-root-delete'
  | 'filesystem-write'
  | 'partition'
  | 'power'
  | 'lockout'
  | 'permission-reset'
  | 'account'
  | 'fork-bomb'
  | 'pipe-to-shell'
  | 'database-drop'

export type Hazard = {
  kind: HazardKind
  /** One sentence, shown next to the line. Says what it does, not "be careful". */
  explanation: string
  /** The line as written, trimmed. */
  line: string
  /** 1-based, so it lines up with what an editor shows. */
  lineNumber: number
}

type Rule = { kind: HazardKind; explanation: string; pattern: RegExp }

/**
 * Ordered so the most specific rule reports first on a line that matches
 * several: `rm -rf /` is a recursive root delete, not merely a filesystem
 * write.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'recursive-root-delete',
    // `/` `/*` `/etc` `/var` and friends, but not `/tmp/build` — a trailing
    // path segment of two or more levels is an ordinary directory removal.
    pattern: /\brm\b[^\n|;&]*\s-[a-z]*[rR][a-z]*f|\brm\b[^\n|;&]*\s-[a-z]*f[a-z]*[rR]/,
    explanation: 'Recursive forced delete. On the wrong path this removes the system.',
  },
  {
    kind: 'partition',
    pattern: /\b(mkfs(\.\w+)?|fdisk|parted|sgdisk|wipefs|cryptsetup\s+luksFormat)\b/,
    explanation: 'Formats or repartitions a disk. Everything on it is gone.',
  },
  {
    kind: 'filesystem-write',
    pattern: /\bdd\b[^\n]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|vd|hd|xvd)/,
    explanation: 'Writes straight to a block device, past the filesystem.',
  },
  {
    kind: 'power',
    /*
     * Only in *command position*.
     *
     * `\breboot\b` on its own flags `reboot=no`, `/var/run/reboot-required`
     * and `echo "reboot required"` — three things that reboot nothing. A
     * guard that cries wolf on a read-only status script is a guard people
     * learn to click through, which is worse than not having one.
     */
    pattern:
      /(?:^|[;&|(]|\bthen\b|\belse\b|\bdo\b)\s*(?:sudo\s+(?:-\w+\s+)*)?(?:\/s?bin\/|\/usr\/s?bin\/)?(?:shutdown|poweroff|halt|reboot)\b(?![-=])|\bsystemctl\s+(?:reboot|poweroff|halt)\b|\binit\s+[06]\b/,
    explanation: 'Reboots or powers off the server. It comes back only if it is set up to.',
  },
  {
    kind: 'lockout',
    pattern:
      /\b(iptables|ip6tables|nft)\b[^\n]*\s(-F|flush)\b|\bufw\s+(disable|reset)\b|\bsystemctl\s+(stop|disable|mask)\s+(ssh|sshd)\b|\bsystemctl\s+stop\s+network/,
    explanation: 'Changes networking or SSH itself. A mistake here locks you out of the server.',
  },
  {
    kind: 'permission-reset',
    pattern: /\bch(mod|own)\b[^\n]*\s-[a-zA-Z]*R[a-zA-Z]*\s+[^\n]*\s\/(\s|$|\*)/,
    explanation: 'Rewrites ownership or permissions from the filesystem root down.',
  },
  {
    kind: 'account',
    pattern: /\b(userdel|groupdel|deluser|delgroup)\b|\bpasswd\b\s+-d\b|\busermod\b[^\n]*\s-L\b/,
    explanation: 'Removes or disables a login. Possibly the one you connect with.',
  },
  {
    kind: 'fork-bomb',
    pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/,
    explanation: 'Fork bomb. The server stops responding until it is power-cycled.',
  },
  {
    kind: 'pipe-to-shell',
    pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/,
    explanation: 'Runs whatever that URL returns, today, on every selected server.',
  },
  {
    kind: 'database-drop',
    pattern: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i,
    explanation: 'Drops a database object. There is no undo on the other side of this.',
  },
]

/** `#` comments and blank lines are not commands and never raise a hazard. */
function isCode(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length > 0 && !trimmed.startsWith('#')
}

/**
 * Whether a recursive delete is aimed somewhere fatal.
 *
 * `rm -rf /srv/app/cache` is a deploy step. `rm -rf /`, `rm -rf /*`,
 * `rm -rf /etc` and `rm -rf "$UNSET/"` are not, and an unset variable at the
 * front of a path is the classic way this goes wrong.
 */
function isFatalDeleteTarget(line: string): boolean {
  // Every pattern tolerates the surrounding quotes, because `rm -rf "/"` is
  // the same command as `rm -rf /` and a guard that only knows one of them is
  // worse than none.
  if (/\brm\b[^\n]*\s["']?\/["']?(\s|$)/.test(line)) return true
  if (/\brm\b[^\n]*\s["']?\/\*/.test(line)) return true
  // A single top-level directory: /etc, /var, /usr, /home, /boot, /root...
  if (/\brm\b[^\n]*\s["']?\/(etc|var|usr|bin|sbin|lib|lib64|boot|home|root|opt|srv|data)\/?["']?(\s|$)/.test(line)) {
    return true
  }
  // A path that begins with an expansion: "$DIR/" is "/" when DIR is unset,
  // which is the single most common way this goes wrong in a deploy script.
  if (/\brm\b[^\n]*\s["']?\$\{?\w+\}?\/["']?(\s|$|\*)/.test(line)) return true
  return false
}

/**
 * Scans a script for the ways a fleet command loses machines.
 *
 * Reports at most one hazard per line — the first rule that matches — because
 * a line flagged three times reads as noise and gets waved through.
 */
export function inspectScript(script: string): Hazard[] {
  const hazards: Hazard[] = []

  script.split('\n').forEach((line, index) => {
    if (!isCode(line)) return

    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue
      // A recursive delete pointed at an ordinary directory is ordinary work.
      if (rule.kind === 'recursive-root-delete' && !isFatalDeleteTarget(line)) continue

      hazards.push({
        kind: rule.kind,
        explanation: rule.explanation,
        line: line.trim(),
        lineNumber: index + 1,
      })
      return
    }
  })

  return hazards
}

/** One line per hazard, for a terminal warning or a dialog body. */
export function describeHazards(hazards: readonly Hazard[]): string[] {
  return hazards.map((hazard) => `line ${hazard.lineNumber}: ${hazard.explanation}\n    ${hazard.line}`)
}
