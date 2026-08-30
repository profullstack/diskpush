import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { knownHostsPath } from '@diskpush/database'
import { SftpBrowser, SshSession } from '@diskpush/ssh-core'
import { defaultRsyncOptions, summarizeChanges, type Connection } from '@diskpush/schemas'
import { parseEndpoint, planTransfer, runToCompletion } from '@diskpush/rsync-core'
import { isChar, type Key } from './keys.js'
import { ansi, formatSize, pad, truncate, width as width_ } from './render.js'

/**
 * A two-pane browser in the terminal.
 *
 * The same shape as the desktop app and driven by the same engine: either pane
 * is local or a server, and transfers run through rsync. It deliberately does
 * not offer Mirror — deleting files from a keystroke, with no delete list on
 * screen, is the accident the rest of DiskPush is built to prevent.
 */

const CTRL_C = String.fromCharCode(3)

export type Entry = { name: string; isDirectory: boolean; size: number }

type Side = 'left' | 'right'

export type Pane = {
  label: string
  connection: Connection | null
  path: string
  entries: Entry[]
  index: number
  offset: number
  error: string | null
}

const HELP =
  'tab switch   arrows/jk move   enter open   left up   c change endpoint   s sync to other   p preview   r refresh   q quit'

/** Somewhere a pane can point at: this machine, or a server. */
export type EndpointChoice = {
  label: string
  detail: string
  connection: Connection | null
  path: string
}

/**
 * Everywhere a pane can be pointed: this machine, then saved connections, then
 * `~/.ssh/config` hosts.
 *
 * Deduplicated by name, in that order of precedence — a saved connection wins
 * over an ssh_config host of the same name (it carries a port, a key and a
 * default path), and ssh_config itself can list one alias more than once.
 */
export function buildEndpointChoices(
  saved: readonly Connection[],
  sshHosts: readonly Connection[],
  localPath: string,
): EndpointChoice[] {
  const choices: EndpointChoice[] = [
    { label: 'Local', detail: 'this machine', connection: null, path: localPath },
    ...saved.map((connection) => ({
      label: connection.name,
      detail: `${connection.username}@${connection.host}`,
      connection,
      path: connection.defaultRemotePath ?? '.',
    })),
    ...sshHosts.map((connection) => ({
      label: connection.name,
      detail: `${connection.username}@${connection.host}  (ssh config)`,
      connection,
      path: '.',
    })),
  ]

  const seen = new Set<string>()
  return choices.filter((choice) => {
    if (seen.has(choice.label)) return false
    seen.add(choice.label)
    return true
  })
}

export function blankPane(label: string, path: string, connection: Connection | null = null): Pane {
  return { label, connection, path, entries: [], index: 0, offset: 0, error: null }
}

export class Tui {
  private readonly panes: Record<Side, Pane>
  private active: Side = 'left'
  private status = ''
  private busy = false
  private readonly sessions = new Map<string, SshSession>()
  /** Open endpoint picker, or null. It owns the keyboard while it is up. */
  private picker: { index: number } | null = null

  constructor(
    left: Pane,
    right: Pane,
    private readonly choices: readonly EndpointChoice[] = [],
  ) {
    this.panes = { left, right }
  }

  private async session(connection: Connection): Promise<SshSession> {
    const existing = this.sessions.get(connection.id)
    if (existing) return existing
    const session = await SshSession.connect(connection, { knownHostsPath: knownHostsPath() })
    this.sessions.set(connection.id, session)
    return session
  }

  async load(side: Side): Promise<void> {
    const pane = this.panes[side]
    pane.error = null
    try {
      pane.entries = pane.connection ? await this.listRemote(pane) : listLocal(pane.path)
      pane.index = 0
      pane.offset = 0
    } catch (error) {
      pane.entries = []
      pane.error = error instanceof Error ? error.message : String(error)
    }
  }

  async loadBoth(): Promise<void> {
    await this.load('left')
    await this.load('right')
  }

  private async listRemote(pane: Pane): Promise<Entry[]> {
    const browser = await SftpBrowser.open(await this.session(pane.connection!))
    try {
      const entries = await browser.list(pane.path)
      return entries
        .map((entry) => ({ name: entry.name, isDirectory: entry.type === 'directory', size: entry.size }))
        .sort(compareEntries)
    } finally {
      browser.close()
    }
  }

  render(): void {
    // `||` not `??`: a terminal that reports 0 columns (some pty wrappers do)
    // is unknown, not zero-width, and `?? 100` lets the 0 through — which made
    // a box width negative and crashed on String.repeat.
    const columns = Math.max(48, process.stdout.columns || 100)
    const rows = Math.max(12, process.stdout.rows || 30)
    const paneWidth = Math.max(20, Math.floor((columns - 3) / 2))
    const listHeight = Math.max(3, rows - 6)

    const out: string[] = [ansi.clear]
    out.push(`${ansi.bold}DiskPush${ansi.reset}${ansi.dim}   two-pane browser${ansi.reset}`)

    const headers = (['left', 'right'] as const).map((side) => {
      const pane = this.panes[side]
      this.clampScroll(side, listHeight)
      const room = Math.max(8, paneWidth - width_(pane.label) - 3)
      const header = `${pane.label} ${ansi.dim}${truncate(pane.path, room)}${ansi.reset}`
      const marker = side === this.active ? `${ansi.blue}>${ansi.reset}` : ' '
      return `${marker}${pad(header, paneWidth)}`
    })
    out.push(headers.join(' '))

    // Drawn row by row so the two panes sit side by side.
    for (let row = 0; row < listHeight; row += 1) {
      const cells = (['left', 'right'] as const).map((side) => {
        const pane = this.panes[side]
        if (pane.error) return row === 0 ? `${ansi.red}${truncate(pane.error, paneWidth)}${ansi.reset}` : ''
        const entry = pane.entries[pane.offset + row]
        if (!entry) return ''
        const selected = pane.offset + row === pane.index && side === this.active
        const name = entry.isDirectory ? `${entry.name}/` : entry.name
        const size = entry.isDirectory ? '' : formatSize(entry.size)
        const body = `${pad(truncate(name, paneWidth - 8), paneWidth - 8)} ${size.padStart(6)}`
        return selected ? `${ansi.reverse}${body}${ansi.reset}` : body
      })
      out.push(` ${pad(cells[0] ?? '', paneWidth)} ${pad(cells[1] ?? '', paneWidth)}`)
    }

    out.push('')
    out.push(this.status === '' ? `${ansi.dim}${truncate(HELP, columns - 1)}${ansi.reset}` : truncate(this.status, columns - 1))

    let frame = out.join('\n')
    if (this.picker) frame += this.renderPicker(columns, rows)
    process.stdout.write(frame)
  }

  private clampScroll(side: Side, height: number): void {
    const pane = this.panes[side]
    if (pane.index < pane.offset) pane.offset = pane.index
    if (pane.index >= pane.offset + height) pane.offset = pane.index - height + 1
    if (pane.offset < 0) pane.offset = 0
  }

  private get current(): Pane {
    return this.panes[this.active]
  }

  private get other(): Pane {
    return this.panes[this.active === 'left' ? 'right' : 'left']
  }

  /** Returns false when the app should exit. */
  async onKey(key: Key): Promise<boolean> {
    if (isChar(key, CTRL_C)) return false

    if (this.picker) {
      // Escape closes the picker rather than the app: inside a dialog it means
      // "not this", which is not the same as "quit".
      if (key === 'escape' || isChar(key, 'q')) {
        this.picker = null
      } else if (key === 'up' || isChar(key, 'k')) {
        this.picker.index = Math.max(0, this.picker.index - 1)
      } else if (key === 'down' || isChar(key, 'j')) {
        this.picker.index = Math.min(this.choices.length - 1, this.picker.index + 1)
      } else if (key === 'enter' || key === 'right' || isChar(key, 'l')) {
        await this.choose(this.picker.index)
      }
      return true
    }

    if (key === 'escape' || isChar(key, 'q')) return false
    if (this.busy) return true

    const page = Math.max(1, Math.max(12, process.stdout.rows || 30) - 8)

    if (key === 'tab') {
      this.active = this.active === 'left' ? 'right' : 'left'
    } else if (key === 'up' || isChar(key, 'k')) {
      this.move(-1)
    } else if (key === 'down' || isChar(key, 'j')) {
      this.move(1)
    } else if (key === 'page-up') {
      this.move(-page)
    } else if (key === 'page-down') {
      this.move(page)
    } else if (key === 'home') {
      this.current.index = 0
    } else if (key === 'end') {
      this.current.index = Math.max(0, this.current.entries.length - 1)
    } else if (key === 'left' || isChar(key, 'h')) {
      await this.goUp()
    } else if (key === 'right' || key === 'enter' || isChar(key, 'l')) {
      await this.enter()
    } else if (isChar(key, 'c')) {
      this.openPicker()
    } else if (isChar(key, 'r')) {
      await this.load(this.active)
    } else if (isChar(key, 'p')) {
      await this.transfer(true)
    } else if (isChar(key, 's')) {
      await this.transfer(false)
    }
    return true
  }

  private move(delta: number): void {
    const pane = this.current
    const last = Math.max(0, pane.entries.length - 1)
    pane.index = Math.min(last, Math.max(0, pane.index + delta))
  }

  private openPicker(): void {
    if (this.choices.length === 0) {
      this.status = `${ansi.yellow}No servers configured. Add one with: diskpush connections add NAME user@host${ansi.reset}`
      return
    }
    const current = this.current.connection
    const at = this.choices.findIndex((choice) =>
      current ? choice.connection?.name === current.name : choice.connection === null,
    )
    this.picker = { index: at >= 0 ? at : 0 }
  }

  /** Points the active pane at the chosen endpoint and lists it. */
  private async choose(index: number): Promise<void> {
    const choice = this.choices[index]
    this.picker = null
    if (!choice) return

    const pane = this.panes[this.active]
    pane.label = choice.label
    pane.connection = choice.connection
    pane.path = choice.path
    pane.entries = []
    pane.index = 0
    pane.offset = 0
    pane.error = null

    this.busy = true
    this.status = `${ansi.dim}Connecting to ${choice.label}...${ansi.reset}`
    this.render()
    try {
      await this.load(this.active)
      this.status = pane.error ? `${ansi.red}${truncate(pane.error, 200)}${ansi.reset}` : ''
    } finally {
      this.busy = false
    }
  }

  /** Draws the picker over the panes. Returns the lines it occupies. */
  private renderPicker(columns: number, rows: number): string {
    const width = Math.max(28, Math.min(64, columns - 8))
    const left = Math.max(1, Math.floor((columns - width) / 2))
    const index = this.picker?.index ?? 0

    // A machine with forty hosts in ~/.ssh/config would otherwise draw a box
    // taller than the terminal, so the list scrolls with the selection.
    const visible = Math.max(3, Math.min(this.choices.length, rows - 8))
    const half = Math.floor(visible / 2)
    const start = Math.max(0, Math.min(this.choices.length - visible, index - half))
    const shown = this.choices.slice(start, start + visible)

    const top = Math.max(1, Math.floor((rows - visible - 4) / 2))
    const out: string[] = []
    const line = (row: number, body: string) => out.push(`${ansi.moveTo(row, left)}${body}`)
    const inner = width - 2

    const title =
      this.choices.length > visible
        ? `Point this pane at   ${start + 1}-${start + shown.length} of ${this.choices.length}`
        : 'Point this pane at'

    line(top, `${ansi.blue}+${'-'.repeat(inner)}+${ansi.reset}`)
    line(top + 1, `${ansi.blue}|${ansi.reset}${ansi.bold}${pad(` ${title}`, inner)}${ansi.reset}${ansi.blue}|${ansi.reset}`)

    shown.forEach((choice, i) => {
      const at = start + i
      const label = pad(truncate(choice.label, 20), 20)
      const detail = truncate(choice.detail, Math.max(4, inner - 24))
      const body = ` ${label} ${detail}`
      const text =
        at === index
          ? `${ansi.reverse}${pad(body, inner)}${ansi.reset}`
          : `${pad(` ${label} `, 22)}${ansi.dim}${detail}${ansi.reset}${' '.repeat(Math.max(0, inner - 22 - width_(detail)))}`
      line(top + 2 + i, `${ansi.blue}|${ansi.reset}${text}${ansi.blue}|${ansi.reset}`)
    })

    line(top + 2 + shown.length, `${ansi.blue}|${ansi.reset}${ansi.dim}${pad(' enter select   esc cancel', inner)}${ansi.reset}${ansi.blue}|${ansi.reset}`)
    line(top + 3 + shown.length, `${ansi.blue}+${'-'.repeat(inner)}+${ansi.reset}`)
    return out.join('')
  }

  private async enter(): Promise<void> {
    const pane = this.current
    const entry = pane.entries[pane.index]
    if (!entry?.isDirectory) return
    pane.path = pane.connection ? posix.join(pane.path, entry.name) : join(pane.path, entry.name)
    await this.load(this.active)
  }

  private async goUp(): Promise<void> {
    const pane = this.current
    const parent = pane.connection ? posix.dirname(pane.path) : join(pane.path, '..')
    if (parent === pane.path) return
    pane.path = parent
    await this.load(this.active)
  }

  private async transfer(previewOnly: boolean): Promise<void> {
    const source = this.current
    const destination = this.other
    this.busy = true
    this.status = `${ansi.yellow}${previewOnly ? 'Previewing' : 'Syncing'} ${source.path} -> ${destination.path}${ansi.reset}`
    this.render()

    try {
      const remote = source.connection ?? destination.connection
      const plan = planTransfer({
        source: parseEndpoint(endpointString(source)),
        destination: parseEndpoint(endpointString(destination)),
        options: defaultRsyncOptions({ dryRun: previewOnly, stats: true }),
        ...(remote ? { remoteShell: { keyPath: remote.keyPath, port: remote.port } } : {}),
      })
      const result = await runToCompletion(plan)
      const summary = summarizeChanges(result.changes)

      if (!result.ok) {
        this.status = `${ansi.red}${truncate(result.message, 200)}${ansi.reset}`
      } else if (previewOnly) {
        this.status = `${ansi.green}Preview: ${summary.add} to add, ${summary.update} to update, ${summary.unchanged} unchanged${ansi.reset}`
      } else {
        this.status = `${ansi.green}Synced ${summary.add + summary.update} files${ansi.reset}`
        await this.load(this.active === 'left' ? 'right' : 'left')
      }
    } catch (error) {
      this.status = `${ansi.red}${truncate(error instanceof Error ? error.message : String(error), 200)}${ansi.reset}`
    } finally {
      this.busy = false
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close()
  }
}

function endpointString(pane: Pane): string {
  const path = pane.path.endsWith('/') ? pane.path : `${pane.path}/`
  if (!pane.connection) return path
  return `${pane.connection.username}@${pane.connection.host}:${path}`
}

function compareEntries(a: Entry, b: Entry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return a.name.localeCompare(b.name)
}

export function listLocal(path: string): Entry[] {
  return readdirSync(path)
    .map((name) => {
      const stats = statSync(join(path, name), { throwIfNoEntry: false })
      return { name, isDirectory: stats?.isDirectory() ?? false, size: stats?.size ?? 0 }
    })
    .sort(compareEntries)
}

export function defaultLocalPath(): string {
  return process.cwd() || homedir()
}
