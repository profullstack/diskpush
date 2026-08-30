import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { knownHostsPath } from '@diskpush/database'
import { SftpBrowser, SshSession } from '@diskpush/ssh-core'
import { defaultRsyncOptions, summarizeChanges, type Connection } from '@diskpush/schemas'
import { parseEndpoint, planTransfer, runToCompletion } from '@diskpush/rsync-core'
import { ansi, formatSize, pad, truncate, width } from './render.js'

/**
 * A two-pane browser in the terminal.
 *
 * The same shape as the desktop app and driven by the same engine: either pane
 * is local or a server, and transfers run through rsync. It deliberately does
 * not offer Mirror — deleting files from a keystroke, with no delete list on
 * screen, is the accident the rest of DiskPush is built to prevent.
 */

const ESCAPE_KEY = String.fromCharCode(27)
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

const HELP = 'tab switch   j/k move   l open   h up   s sync to other   p preview   r refresh   q quit'

export function blankPane(label: string, path: string, connection: Connection | null = null): Pane {
  return { label, connection, path, entries: [], index: 0, offset: 0, error: null }
}

export class Tui {
  private readonly panes: Record<Side, Pane>
  private active: Side = 'left'
  private status = ''
  private busy = false
  private readonly sessions = new Map<string, SshSession>()

  constructor(left: Pane, right: Pane) {
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
    const columns = process.stdout.columns ?? 100
    const rows = process.stdout.rows ?? 30
    const paneWidth = Math.max(20, Math.floor((columns - 3) / 2))
    const listHeight = Math.max(3, rows - 6)

    const out: string[] = [ansi.clear]
    out.push(`${ansi.bold}DiskPush${ansi.reset}${ansi.dim}   two-pane browser${ansi.reset}`)

    const headers = (['left', 'right'] as const).map((side) => {
      const pane = this.panes[side]
      this.clampScroll(side, listHeight)
      const room = Math.max(8, paneWidth - width(pane.label) - 3)
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
    process.stdout.write(out.join('\n'))
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
  async onKey(key: string): Promise<boolean> {
    if (key === 'q' || key === ESCAPE_KEY || key === CTRL_C) return false
    if (this.busy) return true

    switch (key) {
      case '\t':
        this.active = this.active === 'left' ? 'right' : 'left'
        break
      case 'r':
        await this.load(this.active)
        break
      case 'j':
        this.current.index = Math.min(this.current.index + 1, Math.max(0, this.current.entries.length - 1))
        break
      case 'k':
        this.current.index = Math.max(0, this.current.index - 1)
        break
      case 'h':
        await this.goUp()
        break
      case 'l':
      case '\r':
      case '\n':
        await this.enter()
        break
      case 'p':
        await this.transfer(true)
        break
      case 's':
        await this.transfer(false)
        break
      default:
        break
    }
    return true
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
