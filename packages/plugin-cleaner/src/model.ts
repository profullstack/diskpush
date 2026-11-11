/**
 * From scan records to a report a person can act on.
 *
 * Every finding becomes an item with a safety class and a reason:
 *
 *   safe          regenerable: a cache, docker build cache, an old log. The
 *                 only cost of removing it is time the next install or build
 *                 spends fetching or rebuilding it.
 *   safe-if-idle  build output and partial downloads, removable only because
 *                 the guards prove nobody is using them right now.
 *   human         databases, backups, volumes, media, stopped containers:
 *                 reported with a command to look closer, NEVER deleted.
 *
 * Items are ranked by bytes freed per unit of risk; the plan is the eligible
 * items in that order. Pure: no I/O here, so it is tested on fixed text.
 */
import { CACHE_IDS, type ApplyStep, type CacheId } from './script.js'

export type Safety = 'safe' | 'safe-if-idle' | 'human'
export const CLEAN_CATEGORIES = ['caches', 'docker', 'logs', 'build', 'partials'] as const
export type CleanCategory = (typeof CLEAN_CATEGORIES)[number]
export type Category = CleanCategory | 'review'

export type Item = {
  /** Stable for a target: `build:/path`, `cache:npm`, `docker:buildcache`. */
  id: string
  category: Category
  safety: Safety
  title: string
  path: string | null
  /** Estimated bytes freed. -1: unknown (a du ran out of time). */
  bytes: number
  /** The size is an upper bound (pnpm prunes only unreferenced packages; images are age-filtered). */
  upTo: boolean
  /** Applied when its category is chosen. False for every `human` item and for anything a guard stopped. */
  eligible: boolean
  /** Why it is (or is not) safe to remove. */
  why: string
  /** A command a person can run to look closer or do it by hand. */
  suggested: string | null
  /** 1 = regenerable at no cost but time; higher = more to lose if a guard is wrong. */
  risk: number
  /** bytes / risk: the ranking. */
  score: number
  step: ApplyStep | null
}

export type Filesystem = { device: string; mount: string; sizeBytes: number; usedBytes: number; availBytes: number; usedPercent: number }
/** `timedOut`: du ran out of time; `bytes` is then a lower bound (what it had counted), or -1 when it had nothing. */
export type DirSize = { path: string; bytes: number; timedOut: boolean; kind: string | null }
export type Writer = { pid: number; bytesPerSecond: number; command: string; container: string | null; cmdline: string }
export type Kept = { root: string; reason: string; dirs: number }
export type Snapshot = { at: string; fs: Record<string, number>; dirs: Record<string, number> }
export type Growth = {
  since: string
  seconds: number
  fs: { mount: string; deltaBytes: number; bytesPerHour: number }[]
  dirs: { path: string; deltaBytes: number }[]
}

export type Report = {
  target: string
  at: string
  dryRun: true
  os: string
  isRoot: boolean
  sudo: boolean
  home: string
  homeMount: string | null
  idleDays: number
  /** The scan's settings; an apply of this report re-checks with the same ones. */
  scan: { logDir: string; imageAge: string; journalCap: string; partialHours: number }
  filesystems: Filesystem[]
  topDirs: DirSize[]
  writers: Writer[]
  items: Item[]
  kept: Kept[]
  plan: { ids: string[]; bytes: number }
  totals: Record<Category, { bytes: number; count: number; eligible: number }>
  growth: Growth | null
  docker: 'ok' | 'denied' | 'absent'
  warnings: string[]
  snapshot: Snapshot
}

const KIB = 1024
const GIB = 1024 ** 3

/** `12.3GB`, `512MB (40%)`, `0B`: docker's decimal units. */
export function parseDockerSize(text: string | undefined): number {
  const match = /([0-9.]+)\s*([kKMGTP]?B)/.exec(text ?? '')
  if (!match) return 0
  const scale: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 }
  return Math.round(Number(match[1]) * (scale[match[2]!] ?? 1))
}

/** journalctl's `3.9G`, `512.0M`: binary units. */
export function parseBinarySize(text: string | undefined): number {
  const match = /^([0-9.]+)([BKMGT])?$/.exec((text ?? '').trim())
  if (!match) return 0
  const power = { B: 0, K: 1, M: 2, G: 3, T: 4 }[(match[2] ?? 'B') as 'B'] ?? 0
  return Math.round(Number(match[1]) * 1024 ** power)
}

export function formatBytes(bytes: number): string {
  if (bytes < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

type DockerVerbose = {
  Images?: { Containers?: string | number; CreatedAt?: string; Size?: string; UniqueSize?: string }[]
  Containers?: { State?: string; Size?: string }[]
  Volumes?: { Name?: string; Links?: number | string; Size?: string }[]
  BuildCache?: { InUse?: string | boolean; Size?: string }[]
}

/** `2026-11-11 09:56:23 +0000 UTC` -> epoch seconds; 0 when unreadable (so it counts as old). */
export function dockerTime(text: string | undefined): number {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d{4})/.exec(text ?? '')
  if (!match) return 0
  const zone = `${match[3]!.slice(0, 3)}:${match[3]!.slice(3)}`
  const ms = Date.parse(`${match[1]}T${match[2]}${zone}`)
  return Number.isNaN(ms) ? 0 : ms / 1000
}

/** `72h`, `30m`, `90s` -> seconds. */
export function ageSeconds(text: string): number {
  const match = /^(\d+)([smh])$/.exec(text)
  if (!match) return 72 * 3600
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h']
}

/** Pseudo and per-container filesystems that only repeat a real one. */
function isNoiseFs(device: string, mount: string): boolean {
  return (
    /^(tmpfs|devtmpfs|udev|none|overlay|shm|squashfs|efivarfs|proc|sysfs|cgroup2?)$/.test(device) ||
    device.startsWith('/dev/loop') ||
    /^\/(run|snap|sys|proc|dev)(\/|$)/.test(mount) ||
    mount.includes('/containerd-mount') ||
    /\/docker\/(overlay2|containers)\//.test(mount)
  )
}

const REGEN: Record<string, string> = {
  node_modules: 'the package manager reinstalls it (npm/pnpm/yarn/bun install)',
  '.next': 'the next `next build` or `next dev` recreates it',
  '.nuxt': 'the next `nuxt build` or `nuxt dev` recreates it',
  '.turbo': 'turbo rebuilds its cache on the next run',
  '.svelte-kit': 'the next `vite build` or `vite dev` recreates it',
  '.parcel-cache': 'parcel rebuilds it on the next run',
  '.output': 'the next build recreates it',
  target: 'the next `cargo build` recreates it',
  dist: 'the project\'s build recreates it',
  build: 'the project\'s build recreates it',
}

const CACHE_INFO: Record<CacheId, { title: string; command: string; note?: string }> = {
  npm: { title: 'npm download cache', command: 'npm cache clean --force' },
  pnpm: { title: 'pnpm content store', command: 'pnpm store prune', note: 'prune removes only packages no project on this machine references, so it frees up to this much' },
  yarn: { title: 'yarn cache', command: 'yarn cache clean' },
  bun: { title: 'bun install cache', command: 'bun pm cache rm' },
  uv: { title: 'uv cache', command: 'uv cache clean' },
  pip: { title: 'pip wheel cache', command: 'pip cache purge' },
  cargo: { title: 'cargo registry downloads', command: 'rm -rf ~/.cargo/registry/cache' },
  'cargo-src': { title: 'cargo registry sources (unpacked crates)', command: 'rm -rf ~/.cargo/registry/src' },
  go: { title: 'go build cache', command: 'go clean -cache' },
}

/** What a big directory probably is, judged by its name. Null: nothing to say. */
export function classifyDir(path: string, dockerRoot: string | null): string | null {
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() ?? ''
  if (dockerRoot && (path === dockerRoot || path.startsWith(`${dockerRoot}/`))) return 'docker'
  if (lower === '/var/lib/docker' || lower.startsWith('/var/lib/docker/') || lower === '/var/lib/containerd') return 'docker'
  if (/(^|[-_.])(postgres(ql)?|pgdata|pg_?wal|mysql|mariadb|mongo(db)?|redis|clickhouse|elasticsearch|opensearch|influxdb|cassandra|etcd|supabase[-_]?db)([-_.]|$)|\.(sqlite3?|db)$/.test(base)) return 'database'
  if (/(^|[-_.])(backups?|bak|dumps?|snapshots?|archives?)([-_.]|$)/.test(base)) return 'backups'
  if (/^(videos?|movies|music|pictures|photos|media|recordings|downloads|torrents?|desktop)$/.test(base)) return 'media'
  if (lower === '/var/log' || lower.startsWith('/var/log/')) return 'logs'
  return null
}

const REVIEW_WHY: Record<string, string> = {
  database: 'Looks like live database data. Deleting files under a running database corrupts it; free space from inside the database (drop or archive data, lower WAL or binlog retention) or move it to a bigger disk.',
  backups: 'Looks like backups. Only you know which copies you still need; prune them with their own retention (for DiskPush dumps: diskpush dbbackup prune), never in a sweep.',
  media: 'Looks like media or downloads: personal files, not regenerable. Move them to another disk (diskpush push) or delete what you no longer want, by hand.',
}

type Raw = {
  meta: { uid: string; os: string; epoch: number; sudo: boolean; home: string }
  homeMount: string | null
  fs: Filesystem[]
  sizes: Map<string, number>
  /** Paths whose size is only a lower bound. */
  partial: Set<string>
  top: string[]
  writers: Writer[]
  caches: { id: CacheId; path: string; tool: boolean; busy: boolean }[]
  dockerState: 'ok' | 'denied' | 'absent'
  /** Reclaimable bytes per docker category; null when docker did not say. */
  docker: { buildCache: number | null; images: number | null; containers: number | null }
  dockerVolumes: { name: string; links: number; bytes: number }[]
  dockerRoot: string | null
  journal: { bytes: number; root: boolean } | null
  logs: { path: string; writable: number; open: boolean }[]
  builds: { path: string; root: string }[]
  kept: { path: string; root: string; reason: string }[]
  partials: { path: string; state: 'stale' | 'open' | 'recent' }[]
  warnings: string[]
  complete: boolean
}

/** Scan output, line by line, into raw records. Unknown lines are ignored. */
export function parseRecords(output: string, options: { imageAge?: string } = {}): Raw {
  const imageAgeSeconds = ageSeconds(options.imageAge ?? '72h')
  const raw: Raw = {
    meta: { uid: '', os: '', epoch: Date.now() / 1000, sudo: false, home: '' },
    homeMount: null,
    fs: [],
    sizes: new Map(),
    partial: new Set(),
    top: [],
    writers: [],
    caches: [],
    dockerState: 'absent',
    docker: { buildCache: null, images: null, containers: null },
    dockerVolumes: [],
    dockerRoot: null,
    journal: null,
    logs: [],
    builds: [],
    kept: [],
    partials: [],
    warnings: [],
    complete: false,
  }
  const seenFs = new Set<string>()
  for (const line of output.split('\n')) {
    const f = line.split('\t')
    switch (f[0]) {
      case 'META':
        raw.meta = { uid: f[1] ?? '', os: f[2] ?? '', epoch: Number(f[3]) || Date.now() / 1000, sudo: f[4] === '1', home: f[5] ?? '' }
        break
      case 'HOMEFS':
        raw.homeMount = f[1] || null
        break
      case 'FS': {
        const [device = '', size, used, avail, mount = ''] = f.slice(1)
        if (isNoiseFs(device, mount) || seenFs.has(device)) break
        seenFs.add(device)
        const sizeBytes = Number(size) * KIB
        const usedBytes = Number(used) * KIB
        const availBytes = Number(avail) * KIB
        if (!sizeBytes) break
        raw.fs.push({ device, mount, sizeBytes, usedBytes, availBytes, usedPercent: Math.round(((usedBytes) / (usedBytes + availBytes || 1)) * 100) })
        break
      }
      case 'SIZE': {
        if (!f[1]) break
        const kb = Number(f[2])
        const partial = f[3] === '1'
        raw.sizes.set(f[1], Number.isFinite(kb) && kb >= 0 && !(partial && kb === 0) ? kb * KIB : -1)
        if (partial) raw.partial.add(f[1])
        break
      }
      case 'TOP':
        if (f[1]) raw.top.push(f[1])
        break
      case 'WRITER':
        raw.writers.push({
          pid: Number(f[1]),
          bytesPerSecond: Number(f[2]) || 0,
          command: (f[3] ?? '').trim(),
          container: (f[4] ?? '').trim() || null,
          cmdline: (f[5] ?? '').trim(),
        })
        break
      case 'CACHE':
        if ((CACHE_IDS as readonly string[]).includes(f[1] ?? '') && f[2]) {
          raw.caches.push({ id: f[1] as CacheId, path: f[2], tool: f[3] === '1', busy: f[4] === '1' })
        }
        break
      case 'DOCKERSTATE':
        raw.dockerState = f[1] === 'ok' ? 'ok' : 'denied'
        break
      case 'DOCKERDF':
        try {
          const row = JSON.parse(f.slice(1).join('\t')) as { Type?: string; Reclaimable?: string }
          const bytes = parseDockerSize(row.Reclaimable)
          if (row.Type === 'Build Cache') raw.docker.buildCache = bytes
          else if (row.Type === 'Images') raw.docker.images = bytes
          else if (row.Type === 'Containers') raw.docker.containers = bytes
        } catch {
          // a docker that prints something else: no docker numbers
        }
        break
      case 'DOCKERV':
        try {
          const parsed = JSON.parse(f.slice(1).join('\t')) as DockerVerbose
          const now = raw.meta.epoch
          raw.docker.buildCache = (parsed.BuildCache ?? []).filter((b) => String(b.InUse) !== 'true').reduce((sum, b) => sum + parseDockerSize(b.Size), 0)
          raw.docker.images = (parsed.Images ?? [])
            .filter((i) => String(i.Containers) === '0' && now - dockerTime(i.CreatedAt) > imageAgeSeconds)
            .reduce((sum, i) => sum + parseDockerSize(i.UniqueSize ?? i.Size), 0)
          raw.docker.containers = (parsed.Containers ?? []).filter((c) => c.State === 'exited' || c.State === 'created').reduce((sum, c) => sum + parseDockerSize(c.Size), 0)
          for (const v of parsed.Volumes ?? []) {
            if (v.Name) raw.dockerVolumes.push({ name: v.Name, links: Number(v.Links) || 0, bytes: parseDockerSize(v.Size) })
          }
        } catch {
          // no docker numbers
        }
        break
      case 'DOCKERROOT':
        raw.dockerRoot = f[1] || null
        break
      case 'JOURNAL':
        raw.journal = { bytes: parseBinarySize(f[1]), root: f[2] === '1' }
        break
      case 'ROTLOG':
        if (f[1]) raw.logs.push({ path: f[1], writable: Number(f[2]) || 0, open: f[3] === '1' })
        break
      case 'BUILD':
        if (f[1] && f[2]) raw.builds.push({ path: f[1], root: f[2] })
        break
      case 'KEPT':
        if (f[1]) raw.kept.push({ path: f[1], root: f[2] || f[1], reason: f[3] ?? 'kept' })
        break
      case 'PARTIAL':
        if (f[1] && (f[2] === 'stale' || f[2] === 'open' || f[2] === 'recent')) raw.partials.push({ path: f[1], state: f[2] })
        break
      case 'WARN':
        if (f[1]) raw.warnings.push(f[1])
        break
      case 'END':
        raw.complete = true
        break
    }
  }
  return raw
}

function item(partial: Omit<Item, 'score' | 'upTo' | 'suggested' | 'step'> & Partial<Pick<Item, 'upTo' | 'suggested' | 'step'>>): Item {
  const bytes = partial.bytes
  return {
    upTo: false,
    suggested: null,
    step: null,
    ...partial,
    score: partial.safety === 'human' || bytes <= 0 ? 0 : bytes / partial.risk,
  }
}

export type BuildOptions = {
  target: string
  idleDays: number
  partialHours: number
  journalCap: string
  imageAge: string
  useSudo: boolean
  logDir?: string
  /** Don't plan beyond this much free space (bytes) on the home filesystem. 0: plan everything. */
  minFreeBytes?: number
  previous?: Snapshot | null
  now?: Date
}

/** Turns raw records into the report. */
export function buildReport(raw: Raw, options: BuildOptions): Report {
  const items: Item[] = []
  const size = (path: string) => raw.sizes.get(path) ?? -1
  const sudoHint = raw.meta.uid === '0' ? '' : 'sudo '

  for (const c of raw.caches) {
    const info = CACHE_INFO[c.id]
    const bytes = size(c.path)
    const runnable = c.id === 'pnpm' ? c.tool : true
    const reasons = [c.busy ? `${c.id === 'cargo-src' ? 'cargo' : c.id} is running right now` : '', runnable ? '' : 'pnpm is not installed, and only pnpm can prune its store safely']
      .filter(Boolean)
      .join('; ')
    items.push(
      item({
        id: `cache:${c.id}`,
        category: 'caches',
        safety: 'safe',
        title: info.title,
        path: c.path,
        bytes,
        upTo: c.id === 'pnpm',
        eligible: !reasons && bytes !== 0,
        why: reasons
          ? `Kept: ${reasons}.`
          : `A download cache: everything in it is fetched again the next time it is needed, so the only cost is a slower next install or build${info.note ? `; ${info.note}` : ''}.`,
        suggested: info.command,
        risk: 1,
        step: { kind: 'cache', id: `cache:${c.id}`, cache: c.id },
      }),
    )
  }

  if (raw.dockerState === 'denied') {
    items.push(
      item({
        id: 'docker:denied',
        category: 'review',
        safety: 'human',
        title: 'Docker is here but this user cannot reach it',
        path: null,
        bytes: -1,
        eligible: false,
        why: 'Docker build cache and images are often the biggest regenerable use of a disk, but this user is not in the docker group. Run the report as a user who is, or allow sudo (--sudo) when passwordless sudo is set up.',
        suggested: 'sudo docker system df',
        risk: 3,
      }),
    )
  }
  if (raw.docker.buildCache !== null) {
    const reclaim = raw.docker.buildCache
    items.push(
      item({
        id: 'docker:buildcache',
        category: 'docker',
        safety: 'safe',
        title: 'Docker build cache',
        path: raw.dockerRoot,
        bytes: reclaim,
        eligible: reclaim > 0,
        why: 'Layers cached by past `docker build`s that no build is using now. The next build of each image is slower once; nothing else depends on them.',
        suggested: 'docker builder prune -f',
        risk: 1,
        step: { kind: 'docker', id: 'docker:buildcache', what: 'buildcache' },
      }),
    )
  }
  if (raw.docker.images !== null) {
    const reclaim = raw.docker.images
    items.push(
      item({
        id: 'docker:images',
        category: 'docker',
        safety: 'safe',
        title: `Unused docker images older than ${options.imageAge}`,
        path: raw.dockerRoot,
        bytes: reclaim,
        upTo: true,
        eligible: reclaim > 0,
        why: `Images no container (running or stopped) uses, created more than ${options.imageAge} ago. Newer ones stay so a recent deploy can still roll back; anything removed is pulled or rebuilt when it is needed again.`,
        suggested: `docker image prune -a -f --filter until=${options.imageAge}`,
        risk: 1.5,
        step: { kind: 'docker', id: 'docker:images', what: 'images' },
      }),
    )
  }
  if (raw.docker.containers) {
    items.push(
      item({
        id: 'docker:containers',
        category: 'review',
        safety: 'human',
        title: 'Stopped docker containers',
        path: null,
        bytes: raw.docker.containers,
        eligible: false,
        why: 'Stopped containers are often stopped on purpose and can be started again; removing one loses its writable layer. Review them one by one, never in bulk.',
        suggested: 'docker ps -a --filter status=exited --format "table {{.Names}}\\t{{.Status}}\\t{{.Size}}"',
        risk: 3,
      }),
    )
  }
  const unusedVolumes = raw.dockerVolumes.filter((v) => v.links === 0 && v.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  for (const v of unusedVolumes.slice(0, 15)) {
    items.push(
      item({
        id: `volume:${v.name}`,
        category: 'review',
        safety: 'human',
        title: `Docker volume ${v.name} (no container uses it)`,
        path: null,
        bytes: v.bytes,
        eligible: false,
        why: 'Volumes hold data, often a database\'s. "Unused" only means no container is attached right now; a stopped stack\'s data looks exactly the same. Look inside before removing it.',
        suggested: `docker run --rm -v ${v.name}:/v:ro alpine du -sh /v/*  # then, only if it is junk: docker volume rm ${v.name}`,
        risk: 3,
      }),
    )
  }

  if (raw.journal) {
    const cap = parseBinarySize(options.journalCap)
    const over = raw.journal.bytes - cap
    if (over > 0) {
      items.push(
        item({
          id: 'journal',
          category: 'logs',
          safety: 'safe',
          title: `systemd journal (${formatBytes(raw.journal.bytes)}) down to ${options.journalCap}`,
          path: '/var/log/journal',
          bytes: over,
          eligible: raw.journal.root,
          why: raw.journal.root
            ? `Removes the oldest archived journal files until the journal fits in ${options.journalCap}; recent logs stay.`
            : `Removes the oldest archived journal files until the journal fits in ${options.journalCap}. Needs root: run as root, or with --sudo when passwordless sudo works.`,
          suggested: `${sudoHint}journalctl --vacuum-size=${options.journalCap}`,
          risk: 1,
          step: { kind: 'journal', id: 'journal' },
        }),
      )
    }
  }
  for (const log of raw.logs) {
    const bytes = size(log.path)
    const eligible = !log.open && log.writable > 0
    items.push(
      item({
        id: `log:${log.path}`,
        category: 'logs',
        safety: 'safe',
        title: `Rotated log ${log.path}`,
        path: log.path,
        bytes: bytes > 0 ? Math.round(bytes * 0.85) : bytes,
        upTo: true,
        eligible,
        why: log.open
          ? 'Kept: a process still has it open.'
          : log.writable > 0
            ? 'An old, already-rotated log left uncompressed. It is compressed with gzip (about 85% smaller), not deleted.'
            : 'An old, already-rotated log left uncompressed; compressing it needs root.',
        suggested: `${log.writable === 1 ? '' : sudoHint}gzip -9 '${log.path}'`,
        risk: 1,
        step: { kind: 'log', id: `log:${log.path}`, path: log.path },
      }),
    )
  }

  for (const build of raw.builds) {
    const name = build.path.split('/').pop() ?? ''
    const marker = name === 'target' ? 'Cargo.toml or CACHEDIR.TAG' : 'package.json'
    items.push(
      item({
        id: `build:${build.path}`,
        category: 'build',
        safety: 'safe-if-idle',
        title: `${name} in ${build.root}`,
        path: build.path,
        bytes: size(build.path),
        eligible: true,
        why: `Build output of a project nobody is working on: ${marker} beside it, ignored by git, nothing in the project changed for ${options.idleDays}+ days, no running process inside it, and no service, cron job, container mount or linked command uses it. If it is needed again, ${REGEN[name] ?? 'the project\'s build recreates it'}.`,
        suggested: `rm -rf '${build.path}'`,
        risk: 2,
        step: { kind: 'build', id: `build:${build.path}`, path: build.path },
      }),
    )
  }

  for (const partial of raw.partials) {
    const eligible = partial.state === 'stale'
    items.push(
      item({
        id: `partial:${partial.path}`,
        category: 'partials',
        safety: 'safe-if-idle',
        title: `Partial file ${partial.path}`,
        path: partial.path,
        bytes: size(partial.path),
        eligible,
        why:
          partial.state === 'stale'
            ? `An unfinished download or copy: nothing has written to it for ${options.partialHours}+ hours and no process has it open, so whatever was writing it died. A retry starts over.`
            : partial.state === 'open'
              ? 'Kept: a process has it open, so the download or copy may still be running.'
              : `Kept: written to in the last ${options.partialHours} hours, so it may still be in progress.`,
        suggested: `rm -f '${partial.path}'`,
        risk: 1.5,
        step: { kind: 'partial', id: `partial:${partial.path}`, path: partial.path },
      }),
    )
  }

  const topDirs: DirSize[] = raw.top
    .map((path) => {
      const bytes = size(path)
      return { path, bytes, timedOut: bytes < 0 || raw.partial.has(path), kind: classifyDir(path, raw.dockerRoot) }
    })
    // Anything du could not finish first: it may well be the biggest, and a small lower bound
    // (du counted for 20 s before giving up) must not push it off the list. Then by size.
    .sort((a, b) => Number(b.timedOut) - Number(a.timedOut) || (b.bytes < 0 ? Infinity : b.bytes) - (a.bytes < 0 ? Infinity : a.bytes))

  for (const dir of topDirs) {
    if (!dir.kind || !REVIEW_WHY[dir.kind]) continue
    if (!dir.timedOut && dir.bytes < GIB) continue
    items.push(
      item({
        id: `review:${dir.path}`,
        category: 'review',
        safety: 'human',
        title: `${dir.kind === 'database' ? 'Database data' : dir.kind === 'backups' ? 'Backups' : 'Media and downloads'}: ${dir.path}`,
        path: dir.path,
        bytes: dir.bytes,
        eligible: false,
        why: REVIEW_WHY[dir.kind]!,
        suggested: `du -xh -d 1 '${dir.path}' 2>/dev/null | sort -h | tail -20`,
        risk: 3,
      }),
    )
  }

  // Kept build dirs, one line per project and reason.
  const keptMap = new Map<string, Kept>()
  for (const k of raw.kept) {
    const key = `${k.root}\t${k.reason}`
    const entry = keptMap.get(key) ?? { root: k.root, reason: k.reason, dirs: 0 }
    entry.dirs += 1
    keptMap.set(key, entry)
  }

  const order = (a: Item, b: Item) => b.score - a.score || b.bytes - a.bytes
  items.sort((a, b) => (a.safety === 'human' ? 1 : 0) - (b.safety === 'human' ? 1 : 0) || order(a, b))

  const plan = planFor(items, raw, options)
  const totals = Object.fromEntries(
    [...CLEAN_CATEGORIES, 'review'].map((category) => {
      const inCategory = items.filter((i) => i.category === category)
      return [
        category,
        {
          bytes: inCategory.filter((i) => i.eligible || category === 'review').reduce((sum, i) => sum + Math.max(0, i.bytes), 0),
          count: inCategory.length,
          eligible: inCategory.filter((i) => i.eligible).length,
        },
      ]
    }),
  ) as Report['totals']

  const now = options.now ?? new Date(raw.meta.epoch * 1000)
  const snapshot: Snapshot = {
    at: now.toISOString(),
    fs: Object.fromEntries(raw.fs.map((f) => [f.mount, f.usedBytes])),
    dirs: Object.fromEntries(topDirs.filter((d) => d.bytes >= 0).map((d) => [d.path, d.bytes])),
  }

  const warnings = [...raw.warnings]
  if (!raw.complete) warnings.push('The scan did not finish; the report is partial.')
  const timedOut = topDirs.filter((d) => d.timedOut).length
  if (timedOut) warnings.push(`${timedOut} director${timedOut === 1 ? 'y was' : 'ies were'} too big to size in time (shown as ≥ what was counted, or ?): look inside them first.`)

  return {
    target: options.target,
    at: now.toISOString(),
    dryRun: true,
    os: raw.meta.os,
    isRoot: raw.meta.uid === '0',
    sudo: raw.meta.sudo,
    home: raw.meta.home,
    homeMount: raw.homeMount,
    idleDays: options.idleDays,
    scan: { logDir: options.logDir ?? '/var/log', imageAge: options.imageAge, journalCap: options.journalCap, partialHours: options.partialHours },
    filesystems: raw.fs.sort((a, b) => b.usedPercent - a.usedPercent),
    topDirs: topDirs.slice(0, 25),
    writers: raw.writers,
    items,
    kept: [...keptMap.values()].sort((a, b) => b.dirs - a.dirs),
    plan,
    totals,
    growth: growthSince(options.previous ?? null, snapshot),
    docker: raw.dockerState,
    warnings,
    snapshot,
  }
}

/** The eligible items, best first, stopping once a free-space goal is met. */
function planFor(items: readonly Item[], raw: Raw, options: BuildOptions): Report['plan'] {
  const eligible = items.filter((i) => i.eligible && i.safety !== 'human')
  let need = Infinity
  if (options.minFreeBytes && options.minFreeBytes > 0) {
    const fs = raw.fs.find((f) => f.mount === raw.homeMount) ?? raw.fs.find((f) => f.mount === '/')
    need = fs ? options.minFreeBytes - fs.availBytes : Infinity
    if (need <= 0) return { ids: [], bytes: 0 }
  }
  const ids: string[] = []
  let bytes = 0
  for (const i of eligible) {
    if (bytes >= need) break
    ids.push(i.id)
    bytes += Math.max(0, i.bytes)
  }
  return { ids, bytes }
}

export function growthSince(previous: Snapshot | null, now: Snapshot): Growth | null {
  if (!previous) return null
  const seconds = (Date.parse(now.at) - Date.parse(previous.at)) / 1000
  if (!(seconds > 0)) return null
  const fs = Object.entries(now.fs)
    .filter(([mount]) => previous.fs[mount] !== undefined)
    .map(([mount, used]) => {
      const deltaBytes = used - previous.fs[mount]!
      return { mount, deltaBytes, bytesPerHour: Math.round((deltaBytes / seconds) * 3600) }
    })
    .sort((a, b) => b.deltaBytes - a.deltaBytes)
  const dirs = Object.entries(now.dirs)
    .filter(([path]) => previous.dirs[path] !== undefined)
    .map(([path, bytes]) => ({ path, deltaBytes: bytes - previous.dirs[path]! }))
    .filter((d) => d.deltaBytes !== 0)
    .sort((a, b) => b.deltaBytes - a.deltaBytes)
    .slice(0, 10)
  return { since: previous.at, seconds, fs, dirs }
}

/** The items an apply would run: eligible, in a chosen category, optionally only the given ids. */
export function selectSteps(report: Report, choice: { only?: readonly CleanCategory[]; ids?: readonly string[] } = {}): Item[] {
  const only = new Set(choice.only?.length ? choice.only : CLEAN_CATEGORIES)
  const ids = choice.ids?.length ? new Set(choice.ids) : null
  return report.items.filter((i) => i.eligible && i.safety !== 'human' && i.step && only.has(i.category as CleanCategory) && (!ids || ids.has(i.id)))
}

export function parseCategories(text: string | undefined): CleanCategory[] {
  if (!text) return []
  const out: CleanCategory[] = []
  for (const word of text.split(',').map((w) => w.trim()).filter(Boolean)) {
    const normal = word === 'partial' ? 'partials' : word === 'cache' ? 'caches' : word === 'log' ? 'logs' : word
    if (!(CLEAN_CATEGORIES as readonly string[]).includes(normal)) {
      throw new Error(`"${word}" is not a category. Choose from: ${CLEAN_CATEGORIES.join(', ')}.`)
    }
    if (!out.includes(normal as CleanCategory)) out.push(normal as CleanCategory)
  }
  return out
}
