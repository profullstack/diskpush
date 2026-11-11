/**
 * The two shell programs the cleaner runs ON the target: a read-only scan and
 * an apply that deletes only what it is handed AND still passes every guard.
 *
 * Both are plain POSIX sh, fed to `sh -s` on stdin, so the same text runs on
 * this machine and on any server over ssh, with nothing installed there.
 * Neither writes a scratch file: a scan has to work on a disk that is 100%
 * full, which is exactly when it is needed. State lives in shell variables;
 * the one thing written is the apply lock, under $XDG_RUNTIME_DIR (a tmpfs)
 * when there is one.
 *
 * Output is one record per line, fields separated by tabs. Paths holding a
 * tab or a newline are skipped outright rather than escaped.
 */

/** Shell `${...}` has to be written `\${...}` inside a JS template; this undoes the backslash. */
function unescape(text: string): string {
  return text.replaceAll('\\${', '${')
}

/** Directory names that can be build output, and what makes each one provably so. */
export const BUILD_NAMES = ['node_modules', '.next', '.nuxt', '.turbo', '.svelte-kit', '.parcel-cache', '.output', 'target', 'dist', 'build'] as const

/** Partial-download suffixes. */
export const PARTIAL_PATTERNS = ['*.partial', '*.part', '*.crdownload'] as const

export const CACHE_IDS = ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'pip', 'cargo', 'cargo-src', 'go'] as const
export type CacheId = (typeof CACHE_IDS)[number]

export type ScriptOptions = {
  idleDays: number
  partialHours: number
  /** Seconds between the two /proc io samples. 0 skips writers. */
  sampleSeconds: number
  duTimeoutSeconds: number
  findTimeoutSeconds: number
  parallel: number
  /** Directories searched for projects. Empty: the usual ones under $HOME. */
  buildRoots: readonly string[]
  /** Directories searched for stale partial files. Empty: $HOME. */
  partialRoots: readonly string[]
  /** Directories whose children are sized for the report. Empty: the usual system ones. */
  topRoots: readonly string[]
  /** Where rotated logs are looked for. */
  logDir: string
  /** `journalctl --vacuum-size` cap, e.g. 1G. */
  journalCap: string
  /** `docker image prune --filter until=` age, e.g. 72h. */
  imageAge: string
  /** Allow `sudo -n` for the root-only categories (docker without the group, journald, system logs). */
  useSudo: boolean
  /** Which phases to run. */
  phases: readonly Phase[]
  /** Apply only: the lock directory. Default: $XDG_RUNTIME_DIR or /tmp. */
  lockDir?: string
}

export type Phase = 'fs' | 'top' | 'writers' | 'caches' | 'docker' | 'logs' | 'build' | 'partials'
export const ALL_PHASES: readonly Phase[] = ['fs', 'top', 'writers', 'caches', 'docker', 'logs', 'build', 'partials']

export const DEFAULT_SCRIPT_OPTIONS: ScriptOptions = {
  idleDays: 3,
  partialHours: 24,
  sampleSeconds: 3,
  duTimeoutSeconds: 20,
  findTimeoutSeconds: 180,
  parallel: 6,
  buildRoots: [],
  partialRoots: [],
  topRoots: [],
  logDir: '/var/log',
  journalCap: '1G',
  imageAge: '72h',
  useSudo: false,
  phases: ALL_PHASES,
}

/** Single-quotes a word for sh. */
export function shq(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** `name() { printf '%s\n' a b; }`: a list, with `$HOME` left for the target's shell to expand. */
function listFunction(name: string, items: readonly string[], fallback: string): string {
  const words = items.map((item) => (item === '~' ? '"$HOME"' : item.startsWith('~/') ? `"$HOME"/${shq(item.slice(2))}` : shq(item)))
  return `${name}() { ${items.length ? `printf '%s\\n' ${words.join(' ')}` : fallback}; }`
}

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of 0 or more.`)
  return value
}

function sizeWord(value: string, name: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`${name} "${value}" is not valid.`)
  return value
}

/** Variables and helpers both programs share. */
export function prelude(options: ScriptOptions): string {
  const o = options
  return [
    'LC_ALL=C; export LC_ALL',
    `IDLE_DAYS=${positiveInt(o.idleDays, 'idleDays')}`,
    `PARTIAL_MIN=${positiveInt(o.partialHours, 'partialHours') * 60}`,
    `SAMPLE=${positiveInt(o.sampleSeconds, 'sampleSeconds')}`,
    `DU_TIMEOUT=${Math.max(1, positiveInt(o.duTimeoutSeconds, 'duTimeoutSeconds'))}; export DU_TIMEOUT`,
    `FIND_TIMEOUT=${Math.max(1, positiveInt(o.findTimeoutSeconds, 'findTimeoutSeconds'))}`,
    `PAR=${Math.max(1, Math.min(32, positiveInt(o.parallel, 'parallel')))}`,
    `LOG_DIR=${shq(o.logDir)}`,
    `JOURNAL_CAP=${sizeWord(o.journalCap, 'journalCap', /^[0-9]+[KMGT]?$/)}`,
    `IMAGE_AGE=${sizeWord(o.imageAge, 'imageAge', /^[0-9]+[smh]$/)}`,
    `USE_SUDO=${o.useSudo ? 1 : 0}`,
    listFunction(
      'build_roots',
      o.buildRoots,
      `for d in src code projects dev work repos git worktrees scratch Developer; do printf '%s\\n' "$HOME/$d"; done`,
    ),
    listFunction('partial_roots', o.partialRoots, `printf '%s\\n' "$HOME"`),
    listFunction(
      'top_roots',
      o.topRoots,
      `printf '%s\\n' "$HOME" /home /root /var/lib /var/log /var/cache /var/tmp /tmp /opt /srv /usr/local /var/www`,
    ),
    SHARED,
  ].join('\n')
}

/**
 * Helpers. Kept as one raw block so the shell reads exactly what is here.
 *
 * BUILD_FIND is the find(1) predicate for every build-output name; ACTIVE_PRUNE
 * is what an "is this project idle" search skips (build output and .git),
 * so a fresh `npm install` does not count as someone working on it.
 */
const SHARED = unescape(String.raw`
have() { command -v "$1" >/dev/null 2>&1; }
tmo() { t=$1; shift; if have timeout; then timeout "$t" "$@"; else "$@"; fi; }
emit() { printf '%s' "$1"; shift; for f in "$@"; do printf '\t%s' "$f"; done; printf '\n'; }
step() { emit STEP "$*"; }
okpath() { case "$1" in *'	'*|*'
'*|'') return 1 ;; esac; return 0; }
clean_text() { tr '\t\n\r' '   ' | cut -c1-160; }
avail_kb() { df -kP -- "$1" 2>/dev/null | awk 'NR==2{print $4}'; }
is_root() { [ "$(id -u)" = 0 ]; }
SUDO=
if ! is_root && [ "$USE_SUDO" = 1 ] && have sudo && sudo -n true 2>/dev/null; then SUDO='sudo -n'; fi
can_root() { is_root || [ -n "$SUDO" ]; }

# Sizes, in KiB, of paths on stdin (one per line), several du at once, each
# bounded: a du that runs out of time reports -1 instead of hanging the scan.
sizes() {
  tr '\n' '\0' | xargs -0 -P "$PAR" -n 1 sh -c '[ -n "$1" ] || exit 0; k=$( { if command -v timeout >/dev/null 2>&1; then timeout "$DU_TIMEOUT" du -sxk -- "$1"; else du -sxk -- "$1"; fi; } 2>/dev/null | awk "NR==1{print \$1}"); printf "SIZE\t%s\t%s\n" "$1" "\${k:--1}"' sh
}

# Every path some process works in or runs from right now.
# One ls over /proc, not a readlink per process: on a box with thousands of
# processes the loop takes tens of seconds, the ls a fraction of one.
live_paths() { ls -l /proc/[0-9]*/cwd /proc/[0-9]*/exe 2>/dev/null | sed -n 's/^.* -> //p' | sed 's/ (deleted)$//' | sort -u; }
# stdin: paths. True when one is $1 itself or inside it.
any_under() { awk -v r="$1" '$0==r || index($0, r "/")==1 {f=1; exit} END{exit !f}'; }
# stdin: text. True when $1 appears as a whole path (not a prefix of a longer name).
mentions() {
  awk -v r="$1" '{ s=$0; while ((i=index(s, r)) > 0) { c=substr(s, i+length(r), 1); if (c=="" || c !~ /[A-Za-z0-9._-]/) {f=1; exit}; s=substr(s, i+1) } } END{exit !f}'
}

DOCKER=
docker_init() {
  have docker || return 0
  if tmo 15 docker info >/dev/null 2>&1; then DOCKER=docker
  elif [ "$USE_SUDO" = 1 ] && [ -n "$SUDO" ] && tmo 15 sudo -n docker info >/dev/null 2>&1; then DOCKER='sudo -n docker'
  else DOCKER_DENIED=1; fi
}

# What wires a project to the running system: commands linked into a bin
# directory, crontabs, systemd units, and directories bind-mounted into
# running containers. A project any of these names is never cleaned.
wired_text() {
  for d in "$HOME/.local/bin" "$HOME/bin" "$HOME/.bun/bin" "$HOME/.bun/install/global/node_modules" "$HOME/.cargo/bin" "$HOME/go/bin" "$HOME/.npm-global/bin" "$HOME/.npm-global/lib/node_modules" "$HOME/.local/share/pnpm" /usr/local/bin /usr/local/lib/node_modules; do
    [ -d "$d" ] || continue
    for f in "$d"/* "$d"/@*/*; do [ -L "$f" ] && readlink -f -- "$f" 2>/dev/null; done
  done
  if have npm; then g=$(tmo 15 npm root -g 2>/dev/null); [ -d "$g" ] && for f in "$g"/* "$g"/@*/*; do [ -L "$f" ] && readlink -f -- "$f" 2>/dev/null; done; fi
  if have pnpm; then g=$(tmo 15 pnpm root -g 2>/dev/null); [ -d "$g" ] && for f in "$g"/* "$g"/@*/*; do [ -L "$f" ] && readlink -f -- "$f" 2>/dev/null; done; fi
  crontab -l 2>/dev/null
  cat /etc/crontab /etc/cron.d/* 2>/dev/null
  cat /etc/systemd/system/*.service /etc/systemd/system/*.d/*.conf "$HOME"/.config/systemd/user/*.service 2>/dev/null
  if [ -n "$DOCKER" ]; then ids=$(tmo 15 $DOCKER ps -q 2>/dev/null); [ -n "$ids" ] && tmo 30 $DOCKER inspect --format '{{range .Mounts}}{{.Source}}
{{end}}' $ids 2>/dev/null; fi
}

BUILD_FIND='( -name node_modules -o -name .next -o -name .nuxt -o -name .turbo -o -name .svelte-kit -o -name .parcel-cache -o -name .output -o -name target -o -name dist -o -name build )'
is_build_name() { case "$1" in node_modules|.next|.nuxt|.turbo|.svelte-kit|.parcel-cache|.output|target|dist|build) return 0 ;; esac; return 1; }

# Why build dir $1 must stay, or nothing (and true) when it is provably build output.
build_shape() {
  a=$1; d=\${a%/*}; n=\${a##*/}
  [ -L "$a" ] && { echo "a symlink"; return 1; }
  [ -d "$a" ] || { echo "gone"; return 1; }
  is_build_name "$n" || { echo "not a build-output name"; return 1; }
  case "$n" in
    target) [ -f "$d/Cargo.toml" ] || [ -f "$a/CACHEDIR.TAG" ] || { echo "no Cargo.toml or CACHEDIR.TAG"; return 1; } ;;
    *) [ -f "$d/package.json" ] || { echo "no package.json next to it"; return 1; } ;;
  esac
  if git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$d" check-ignore -q -- "$a" 2>/dev/null || { echo "not git-ignored (it may be committed)"; return 1; }
  else
    case "$n" in dist|build|.output) echo "not in a git repository, so nothing proves $n is generated"; return 1 ;; esac
  fi
  return 0
}

project_root() { git -C "$1" rev-parse --show-toplevel 2>/dev/null || echo "$1"; }

# Why project $1 is busy, or nothing (and true) when it is idle.
# Needs LIVE and WIRED set.
project_busy() {
  r=$1
  printf '%s\n' "$LIVE" | any_under "$r" && { echo "a running process works in it"; return 1; }
  printf '%s\n' "$WIRED" | mentions "$r" && { echo "a service, cron job, container mount or linked command uses it"; return 1; }
  f=$(find "$r" -xdev \( -name .git -o $BUILD_FIND \) -prune -o -type f -mtime -"$IDLE_DAYS" -print 2>/dev/null | head -n 1)
  [ -n "$f" ] && { echo "files changed in the last $IDLE_DAYS days"; return 1; }
  return 0
}

# Is file $1 open by any process we can see?
is_open() {
  if have fuser; then fuser -s -- "$1" 2>/dev/null && return 0; return 1; fi
  ls -l /proc/[0-9]*/fd/ 2>/dev/null | sed -n 's/^.* -> //p' | grep -qxF -- "$1"
}
is_partial_name() { case "\${1##*/}" in *.partial|*.part|*.crdownload) return 0 ;; esac; return 1; }
is_rotated_log() {
  case "$1" in "$LOG_DIR"/*) ;; *) return 1 ;; esac
  case "$1" in *.gz|*.xz|*.zst|*.bz2|*.lz4) return 1 ;; esac
  case "\${1##*/}" in *.[0-9]|*.[0-9][0-9]|*.log.[0-9]*|*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) return 0 ;; esac
  return 1
}

# Where each cache lives on this machine.
cache_path() {
  case "$1" in
    npm) echo "\${npm_config_cache:-$HOME/.npm}/_cacache" ;;
    pnpm) p=; have pnpm && p=$(tmo 15 pnpm store path 2>/dev/null); echo "\${p:-$HOME/.local/share/pnpm/store}" ;;
    yarn) p=; have yarn && p=$(tmo 15 yarn cache dir 2>/dev/null); echo "\${p:-$HOME/.cache/yarn}" ;;
    bun) echo "\${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}" ;;
    uv) echo "\${UV_CACHE_DIR:-$HOME/.cache/uv}" ;;
    pip) echo "\${PIP_CACHE_DIR:-$HOME/.cache/pip}" ;;
    cargo) echo "\${CARGO_HOME:-$HOME/.cargo}/registry/cache" ;;
    cargo-src) echo "\${CARGO_HOME:-$HOME/.cargo}/registry/src" ;;
    go) p=; have go && p=$(tmo 15 go env GOCACHE 2>/dev/null); echo "\${p:-$HOME/.cache/go-build}" ;;
  esac
}
# The program whose own command empties the cache (and that must not be running).
cache_tool() { case "$1" in cargo|cargo-src) echo cargo ;; *) echo "$1" ;; esac; }
cache_busy() { have pgrep && pgrep -x "$(cache_tool "$1")" >/dev/null 2>&1; }
`)

/** The read-only scan. Prints records; deletes nothing, writes nothing. */
export function scanScript(options: ScriptOptions): string {
  const phases = new Set(options.phases)
  const parts = [prelude(options), SCAN_HEAD]
  if (phases.has('fs')) parts.push(SCAN_FS)
  if (phases.has('docker') || phases.has('build')) parts.push('docker_init; [ -n "${DOCKER_DENIED:-}" ] && emit DOCKERSTATE denied; [ -n "$DOCKER" ] && emit DOCKERSTATE ok')
  if (phases.has('writers')) parts.push(SCAN_WRITERS)
  if (phases.has('top')) parts.push(SCAN_TOP)
  if (phases.has('caches')) parts.push(SCAN_CACHES)
  if (phases.has('docker')) parts.push(SCAN_DOCKER)
  if (phases.has('logs')) parts.push(SCAN_LOGS)
  if (phases.has('build')) parts.push(SCAN_BUILD)
  if (phases.has('partials')) parts.push(SCAN_PARTIALS)
  parts.push('emit END')
  return parts.join('\n')
}

const SCAN_HEAD = unescape(String.raw`
emit META "$(id -u)" "$(uname -s)" "$(date +%s)" "$([ -n "$SUDO" ] && echo 1 || echo 0)" "$HOME"
emit HOMEFS "$(df -kP -- "$HOME" 2>/dev/null | awk 'NR==2{print $6}')"
`)

const SCAN_FS = unescape(String.raw`
step "filesystems"
df -kP 2>/dev/null | awk 'NR>1 && NF>=6 {m=$6; for (i=7;i<=NF;i++) m=m" "$i; printf "FS\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, m}'
`)

const SCAN_WRITERS = unescape(String.raw`
if [ "$SAMPLE" -gt 0 ] && [ -r /proc/self/io ]; then
  step "sampling disk writers for $SAMPLE s"
  wa=$(grep -H '^write_bytes' /proc/[0-9]*/io 2>/dev/null)
  sleep "$SAMPLE"
  wb=$(grep -H '^write_bytes' /proc/[0-9]*/io 2>/dev/null)
  NAMES=
  [ -n "$DOCKER" ] && NAMES=$(tmo 15 $DOCKER ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null)
  { printf '%s\n' "$wa" | sed 's/^/A /'; printf '%s\n' "$wb" | sed 's/^/B /'; } \
    | awk -v s="$SAMPLE" '{ split($2, p, "/"); pid=p[3]; v=$3+0; if ($1=="A") a[pid]=v; else if (pid in a) { d=v-a[pid]; if (d>0) print pid, int(d/s) } }' \
    | sort -k2 -nr | head -n 12 | while read -r pid rate; do
      comm=$(cat "/proc/$pid/comm" 2>/dev/null | clean_text)
      cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | clean_text)
      cid=$(grep -oE '[0-9a-f]{64}' "/proc/$pid/cgroup" 2>/dev/null | head -n 1)
      cname=
      [ -n "$cid" ] && cname=$(printf '%s\n' "$NAMES" | awk -v c="$cid" '$1==c {print $2; exit}')
      [ -n "$cid" ] && [ -z "$cname" ] && cname=$(printf '%.12s' "$cid")
      emit WRITER "$pid" "$rate" "$comm" "$cname" "$cmd"
    done
fi
`)

const SCAN_TOP = unescape(String.raw`
step "sizing the biggest directories"
# One bounded du per root sizes all its children in a single pass. A root too
# big for that (or one that holds another root, like /home holding $HOME) is
# sized folder by folder instead, several du at a time, each bounded on its
# own, so one huge folder shows as "?" instead of hiding the rest.
ROOTS=$(top_roots)
per_child() {
  kids=$(for c in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -d "$c" ] && [ ! -L "$c" ] && okpath "$c" || continue
    printf '%s\n' "$ROOTS" | grep -qxF -- "$c" && continue
    printf '%s\n' "$c"
  done | head -n 400)
  printf '%s\n' "$kids" | while IFS= read -r c; do [ -n "$c" ] && emit TOP "$c"; done
  printf '%s\n' "$kids" | sizes
}
printf '%s\n' "$ROOTS" | while IFS= read -r r; do
  [ -d "$r" ] && [ ! -L "$r" ] || continue
  okpath "$r" || continue
  case "$r" in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/run|/run/*) continue ;; esac
  step "sizing $r"
  if printf '%s\n' "$ROOTS" | awk -v r="$r" 'index($0, r "/")==1 && substr($0, length(r)+2) !~ /\// {f=1} END{exit !f}'; then
    per_child "$r"
    continue
  fi
  out=$(tmo $((DU_TIMEOUT * 3)) du -xak -d 1 -- "$r" 2>/dev/null; echo "rc=$?")
  rc=\${out##*rc=}
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    emit WARN "$r is too big to size in one pass; sized its folders one by one"
    per_child "$r"
  else
    printf '%s\n' "$out" | awk -F '\t' -v r="$r" 'NF==2 && $2!=r && $1 ~ /^[0-9]+$/ { printf "TOP\t%s\nSIZE\t%s\t%s\n", $2, $2, $1 }'
  fi
done
`)

const SCAN_CACHES = unescape(String.raw`
step "package-manager caches"
for id in npm pnpm yarn bun uv pip cargo cargo-src go; do
  p=$(cache_path "$id")
  [ -d "$p" ] && [ ! -L "$p" ] && okpath "$p" || continue
  avail=0; have "$(cache_tool "$id")" && avail=1
  busy=0; cache_busy "$id" && busy=1
  emit CACHE "$id" "$p" "$avail" "$busy"
  printf '%s\n' "$p" | sizes
done
`)

const SCAN_DOCKER = unescape(String.raw`
if [ -n "$DOCKER" ]; then
  # One verbose call carries images (with ages), containers, volumes and the
  # build cache. It can take minutes on a busy host; the summary is the fallback.
  step "docker disk usage (can take a few minutes on a busy host)"
  v=$(tmo 240 $DOCKER system df -v --format '{{json .}}' 2>/dev/null | tr -d '\n\t')
  if [ -n "$v" ]; then emit DOCKERV "$v"
  else tmo 120 $DOCKER system df --format '{{json .}}' 2>/dev/null | while IFS= read -r l; do emit DOCKERDF "$l"; done; fi
  root=$(tmo 15 $DOCKER info --format '{{.DockerRootDir}}' 2>/dev/null)
  [ -n "$root" ] && emit DOCKERROOT "$root"
fi
`)

const SCAN_LOGS = unescape(String.raw`
step "logs"
if have journalctl; then
  u=$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[BKMGT]' | head -n 1)
  [ -n "$u" ] && emit JOURNAL "$u" "$(can_root && echo 1 || echo 0)"
fi
if [ -d "$LOG_DIR" ]; then
  OUT=$(tmo "$FIND_TIMEOUT" find "$LOG_DIR" -xdev -type f -size +1024k 2>/dev/null | while IFS= read -r f; do
    okpath "$f" && is_rotated_log "$f" || continue
    w=0; { [ -w "$f" ] && [ -w "\${f%/*}" ]; } && w=1; [ "$w" = 0 ] && can_root && w=2
    open=0; is_open "$f" && open=1
    emit ROTLOG "$f" "$w" "$open"
  done)
  printf '%s\n' "$OUT"
  printf '%s\n' "$OUT" | awk -F '\t' '$1=="ROTLOG" {print $2}' | sizes
fi
`)

const SCAN_BUILD = unescape(String.raw`
step "finding build output"
LIVE=$(live_paths)
WIRED=$(wired_text)
OUT=$(build_roots | while IFS= read -r r; do
  [ -d "$r" ] || continue
  tmo "$FIND_TIMEOUT" find "$r" -xdev -name .git -prune -o -type d $BUILD_FIND -prune -print 2>/dev/null
  [ $? = 124 ] && emit WARN "the search of $r ran out of time; some build output may be missing"
done | {
  VERDICTS=
  while IFS= read -r a; do
    case "$a" in WARN'	'*) printf '%s\n' "$a"; continue ;; esac
    okpath "$a" || continue
    if ! why=$(build_shape "$a"); then
      # Not a project at all (a node_modules in a random folder): not worth a line.
      case "$why" in "no package.json next to it"|"no Cargo.toml or CACHEDIR.TAG") ;; *) emit KEPT "$a" "$a" "$why" ;; esac
      continue
    fi
    root=$(project_root "\${a%/*}")
    if ! v=$(printf '%s' "$VERDICTS" | awk -F '\t' -v r="$root" '$1==r {print $2; f=1; exit} END{exit !f}'); then
      v=$(project_busy "$root") && v=idle
      VERDICTS="$VERDICTS$root	$v
"
    fi
    if [ "$v" = idle ]; then emit BUILD "$a" "$root"; else emit KEPT "$a" "$root" "$v"; fi
  done
})
printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | awk -F '\t' '$1=="BUILD" {print $2}' | sizes
`)

const SCAN_PARTIALS = unescape(String.raw`
step "stale partial files"
OUT=$(partial_roots | while IFS= read -r r; do
  [ -d "$r" ] || continue
  tmo "$FIND_TIMEOUT" find "$r" -xdev \( -name .git -o -name node_modules -o -name .cache -o -name .rustup -o -name .cargo \) -prune -o -type f \( -name '*.partial' -o -name '*.part' -o -name '*.crdownload' \) -print 2>/dev/null
done | while IFS= read -r f; do
  okpath "$f" && [ ! -L "$f" ] || continue
  if [ -z "$(find "$f" -mmin +"$PARTIAL_MIN" 2>/dev/null)" ]; then s=recent; elif is_open "$f"; then s=open; else s=stale; fi
  emit PARTIAL "$f" "$s"
done)
printf '%s\n' "$OUT"
printf '%s\n' "$OUT" | awk -F '\t' '$1=="PARTIAL" {print $2}' | sizes
`)

/** One thing to remove, as the apply program takes it. */
export type ApplyStep =
  | { kind: 'build'; id: string; path: string }
  | { kind: 'partial'; id: string; path: string }
  | { kind: 'log'; id: string; path: string }
  | { kind: 'cache'; id: string; cache: CacheId }
  | { kind: 'docker'; id: string; what: 'buildcache' | 'images' }
  | { kind: 'journal'; id: string }

export type ApplyOptions = ScriptOptions & {
  /** Stop once this many KiB are free on `stopPath`. 0: do every step. */
  stopAtKb: number
  stopPath: string
}

/**
 * The apply program. Every step is checked again here, on the target, at
 * the moment of deleting: a project that became active since the scan, a
 * partial file someone opened, a path that turned into a symlink, are all
 * skipped. Commands come from a fixed table keyed by id, never from input.
 */
export function applyScript(options: ApplyOptions, steps: readonly ApplyStep[]): string {
  const lines = [prelude(options), applyHead(options)]
  for (const s of steps) {
    const id = shq(s.id)
    switch (s.kind) {
      case 'build':
      case 'partial':
      case 'log':
        lines.push(`go && do_${s.kind} ${id} ${shq(s.path)}`)
        break
      case 'cache':
        if (!(CACHE_IDS as readonly string[]).includes(s.cache)) throw new Error(`Unknown cache ${s.cache}.`)
        lines.push(`go && do_cache ${id} ${s.cache}`)
        break
      case 'docker':
        if (s.what !== 'buildcache' && s.what !== 'images') throw new Error(`Unknown docker step ${s.what}.`)
        lines.push(`go && do_docker ${id} ${s.what}`)
        break
      case 'journal':
        lines.push(`go && do_journal ${id}`)
        break
    }
  }
  lines.push('emit END')
  return lines.join('\n')
}

function applyHead(options: ApplyOptions): string {
  return [
    `STOP_AT_KB=${positiveInt(options.stopAtKb, 'stopAtKb')}`,
    `STOP_PATH=${shq(options.stopPath || '/')}`,
    `LOCKD=${options.lockDir ? shq(options.lockDir) : '"${XDG_RUNTIME_DIR:-/tmp}/diskpush-cleaner-$(id -u).lock"'}`,
    APPLY_LIB,
  ].join('\n')
}

const APPLY_LIB = unescape(String.raw`
# One clean at a time per user per machine: a cron run and a click never overlap.
if ! mkdir "$LOCKD" 2>/dev/null; then
  op=$(cat "$LOCKD/pid" 2>/dev/null)
  if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then emit LOCKED "$op"; exit 75; fi
  rm -rf "$LOCKD"; mkdir "$LOCKD" 2>/dev/null || { emit LOCKED unknown; exit 75; }
fi
echo $$ > "$LOCKD/pid" 2>/dev/null
trap 'rm -rf "$LOCKD"' EXIT
trap 'exit 130' INT TERM
docker_init
LIVE=$(live_paths)
WIRED=$(wired_text)
STOPPED=0
go() {
  [ "$STOPPED" = 1 ] && return 1
  if [ "$STOP_AT_KB" -gt 0 ]; then
    av=$(avail_kb "$STOP_PATH")
    if [ -n "$av" ] && [ "$av" -ge "$STOP_AT_KB" ]; then emit STOPPED "$av"; STOPPED=1; return 1; fi
  fi
  return 0
}
# result ID ok|skipped|failed BEFORE_KB AFTER_KB MESSAGE (avail on the path's filesystem)
result() { emit RESULT "$@"; }
do_build() {
  id=$1; a=$2
  okpath "$a" || { result "$id" skipped 0 0 "unusable path"; return 0; }
  why=$(build_shape "$a") || { result "$id" skipped 0 0 "$why"; return 0; }
  root=$(project_root "\${a%/*}")
  why=$(project_busy "$root") || { result "$id" skipped 0 0 "$why"; return 0; }
  b=$(avail_kb "\${a%/*}")
  step "removing $a"
  if rm -rf -- "$a" 2>/dev/null; then result "$id" ok "$b" "$(avail_kb "\${a%/*}")" "removed"
  else result "$id" failed "$b" "$(avail_kb "\${a%/*}")" "partly removed: some files are not yours to delete"; fi
}
do_partial() {
  id=$1; f=$2
  okpath "$f" && [ -f "$f" ] && [ ! -L "$f" ] && is_partial_name "$f" || { result "$id" skipped 0 0 "not a partial file any more"; return 0; }
  [ -n "$(find "$f" -mmin +"$PARTIAL_MIN" 2>/dev/null)" ] || { result "$id" skipped 0 0 "written to recently"; return 0; }
  is_open "$f" && { result "$id" skipped 0 0 "a process has it open"; return 0; }
  b=$(avail_kb "\${f%/*}")
  if rm -f -- "$f"; then result "$id" ok "$b" "$(avail_kb "\${f%/*}")" "removed"; else result "$id" failed "$b" "$b" "could not remove"; fi
}
do_log() {
  id=$1; f=$2
  okpath "$f" && [ -f "$f" ] && [ ! -L "$f" ] && is_rotated_log "$f" || { result "$id" skipped 0 0 "not a rotated log"; return 0; }
  is_open "$f" && { result "$id" skipped 0 0 "a process has it open"; return 0; }
  have gzip || { result "$id" skipped 0 0 "no gzip"; return 0; }
  run=; { [ -w "$f" ] && [ -w "\${f%/*}" ]; } || run=$SUDO
  { [ -w "$f" ] && [ -w "\${f%/*}" ]; } || [ -n "$run" ] || is_root || { result "$id" skipped 0 0 "needs root"; return 0; }
  b=$(avail_kb "\${f%/*}")
  if $run gzip -9 -- "$f" 2>/dev/null; then result "$id" ok "$b" "$(avail_kb "\${f%/*}")" "compressed"; else result "$id" failed "$b" "$(avail_kb "\${f%/*}")" "gzip failed"; fi
}
do_cache() {
  id=$1; c=$2; p=$(cache_path "$c"); t=$(cache_tool "$c")
  [ -d "$p" ] && [ ! -L "$p" ] || { result "$id" skipped 0 0 "no cache at $p"; return 0; }
  cache_busy "$c" && { result "$id" skipped 0 0 "$t is running"; return 0; }
  b=$(avail_kb "$p")
  step "emptying the $c cache"
  case "$c" in
    npm) if have npm; then npm cache clean --force >/dev/null 2>&1; else rm -rf -- "$p"; fi ;;
    pnpm) if have pnpm; then pnpm store prune >/dev/null 2>&1; else result "$id" skipped 0 0 "pnpm is not installed, and its store is pruned only by pnpm"; return 0; fi ;;
    yarn) if have yarn; then yarn cache clean >/dev/null 2>&1; else rm -rf -- "$p"; fi ;;
    bun) if have bun; then bun pm cache rm >/dev/null 2>&1; else rm -rf -- "$p"; fi ;;
    uv) if have uv; then uv cache clean >/dev/null 2>&1; else rm -rf -- "$p"; fi ;;
    pip) if have pip; then pip cache purge >/dev/null 2>&1; elif have python3; then python3 -m pip cache purge >/dev/null 2>&1; else rm -rf -- "$p"; fi ;;
    cargo|cargo-src) rm -rf -- "$p" ;;
    go) if have go; then go clean -cache >/dev/null 2>&1; else rm -rf -- "$p"; fi ;;
  esac
  result "$id" ok "$b" "$(avail_kb "$p")" "emptied"
}
do_docker() {
  id=$1; w=$2
  [ -n "$DOCKER" ] || { result "$id" skipped 0 0 "docker is not reachable$( [ -n "\${DOCKER_DENIED:-}" ] && echo ' (permission denied)')"; return 0; }
  r=$(tmo 15 $DOCKER info --format '{{.DockerRootDir}}' 2>/dev/null); [ -d "$r" ] || r=/
  b=$(avail_kb "$r")
  case "$w" in
    buildcache) step "pruning the docker build cache"; tmo 1800 $DOCKER builder prune -f >/dev/null 2>&1 ;;
    images) step "pruning unused docker images older than $IMAGE_AGE"; tmo 1800 $DOCKER image prune -a -f --filter "until=$IMAGE_AGE" >/dev/null 2>&1 ;;
  esac
  if [ $? = 0 ]; then result "$id" ok "$b" "$(avail_kb "$r")" "pruned"; else result "$id" failed "$b" "$(avail_kb "$r")" "docker prune failed"; fi
}
do_journal() {
  id=$1
  have journalctl || { result "$id" skipped 0 0 "no journalctl"; return 0; }
  can_root || { result "$id" skipped 0 0 "needs root"; return 0; }
  b=$(avail_kb /var/log)
  if $SUDO journalctl --vacuum-size="$JOURNAL_CAP" >/dev/null 2>&1; then result "$id" ok "$b" "$(avail_kb /var/log)" "vacuumed to $JOURNAL_CAP"; else result "$id" failed "$b" "$(avail_kb /var/log)" "journalctl failed"; fi
}
`)
