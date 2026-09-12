/**
 * A two-pane browser in the terminal, drawn with HQTUI.
 *
 * The same shape as the desktop app and driven by the same engine: either pane
 * is local or a server, and transfers run through rsync. It deliberately does
 * not offer Mirror — deleting files from a keystroke, with no delete list on
 * screen, is the accident the rest of DiskPush is built to prevent.
 *
 * This class owns state and effects only. The frame is `view.ts`, the state
 * shape is `model.ts`, and neither of those touches a terminal — so the whole
 * screen can be rendered and asserted on in a test with no pty.
 */
import { join, posix } from 'node:path'
import type { App, Container, KeyEvent, MouseEvent, Theme } from '@profullstack/hqtui'
import { knownHostsPath } from '@diskpush/database'
import { SftpBrowser, SshSession } from '@diskpush/ssh-core'
import { defaultRsyncOptions, type Change, type Connection } from '@diskpush/schemas'
import { parseEndpoint, planTransfer, runToCompletion } from '@diskpush/rsync-core'
import {
  type EndpointChoice,
  type Entry,
  type Overlay,
  type Pane,
  type Row,
  type Side,
  type SortKey,
  SORT_KEYS,
  type Transfer,
  blankPane,
  clampIndex,
  listLocal,
  parentPath,
  pushChange,
  resetTree,
  selectedRow,
  visibleRows,
} from './model.js'
import { type Action, type Tone, type ViewState, draw, filterChoices } from './view.js'

export {
  blankPane,
  buildEndpointChoices,
  defaultLocalPath,
  listLocal,
  type Entry,
  type EndpointChoice,
  type Pane,
} from './model.js'

/** How many rows the wheel moves per notch. */
const WHEEL_ROWS = 3

export class Tui {
  private readonly panes: Record<Side, Pane>
  private active: Side = 'left'
  /** Whatever is on screen instead of the panes, and owns the keyboard while it is. */
  private overlay: Overlay | null = null
  private transfer: Transfer | null = null
  private filtering: Side | null = null
  private status: { text: string; tone: Tone } | null = null
  private busy = false
  private readonly sessions = new Map<string, SshSession>()
  private app: App | null = null
  /**
   * Whether a row claimed the pointer during the mouse event being handled.
   * A tree only hears the pointer while it is inside, so a move that no row
   * claimed is the pointer leaving, and the hover goes with it.
   */
  private hoverSeen = false

  constructor(
    left: Pane,
    right: Pane,
    private readonly choices: readonly EndpointChoice[] = [],
  ) {
    this.panes = { left, right }
  }

  /** Binds the app so background work (a load, a transfer tick) can redraw. */
  attach(app: App): void {
    this.app = app
  }

  private invalidate(): void {
    this.app?.invalidate()
  }

  // ------------------------------------------------------------------ view

  snapshot(): ViewState {
    return {
      panes: this.panes,
      active: this.active,
      overlay: this.overlay,
      transfer: this.transfer,
      filtering: this.filtering,
      status: this.status,
      choices: this.choices,
      now: new Date(),
    }
  }

  /** The render callback handed to `app.render`. */
  view(ui: Container, theme: Theme, width: number, height: number): void {
    draw(ui, theme, width, height, this.snapshot(), {
      onPaneFocus: (side) => {
        this.active = side
        this.invalidate()
      },
      onSelectRow: (side, index) => {
        this.status = null
        this.active = side
        const pane = this.panes[side]
        pane.index = index
        clampIndex(pane)
        const row = selectedRow(pane)
        if (row?.entry.isDirectory && !this.busy) void this.toggle(side, row)
        this.invalidate()
      },
      onGoUp: (side) => {
        if (this.busy) return
        this.status = null
        this.active = side
        void this.goUp()
      },
      onHoverRow: (side, index) => {
        this.hoverSeen = true
        const pane = this.panes[side]
        const other = this.panes[side === 'left' ? 'right' : 'left']
        if (pane.hover === index && other.hover === null) return
        pane.hover = index
        other.hover = null
        this.invalidate()
      },
      onScroll: (side, delta) => {
        this.active = side
        this.move(delta * WHEEL_ROWS)
        this.invalidate()
      },
      onAction: (action) => void this.run(action),
      onPickChoice: (choice) => {
        if (this.overlay?.kind !== 'picker') return
        this.overlay = null
        void this.choose(choice)
      },
      onDismissOverlay: () => {
        // The host-key question is not on this list on purpose: it is only
        // ever answered, never waved away.
        if (this.overlay?.kind === 'picker' || this.overlay?.kind === 'help') this.overlay = null
        this.invalidate()
      },
      onHostKeyDecide: (trust) => {
        if (this.overlay?.kind === 'hostKey') this.overlay.decide(trust)
      },
    })
  }

  /**
   * Every mouse event, after the frame's regions have had it. The only thing
   * left to learn here is a move that no row claimed: the pointer has left the
   * rows, so nothing should stay lit.
   */
  onMouse(event: MouseEvent): void {
    if (event.action === 'move' && !this.hoverSeen) {
      if (this.panes.left.hover !== null || this.panes.right.hover !== null) {
        this.panes.left.hover = null
        this.panes.right.hover = null
        this.invalidate()
      }
    }
    this.hoverSeen = false
  }

  /**
   * A key cap clicked in the footer or the header. Each one does what the key
   * does, under the same rules: a dialog owns the input while it is up, and a
   * transfer in flight takes nothing but cancel and quit.
   */
  private async run(action: Action): Promise<void> {
    if (action === 'quit') {
      this.app?.quit()
      return
    }
    if (action === 'closeOverlay') {
      if (this.overlay?.kind === 'picker' || this.overlay?.kind === 'help') this.overlay = null
      this.invalidate()
      return
    }
    if (action === 'cancelTransfer' || action === 'dismissTransfer') {
      this.dismissTransfer()
      this.invalidate()
      return
    }
    if (this.overlay || this.filtering) return

    this.status = null
    switch (action) {
      case 'pane':
        this.active = this.active === 'left' ? 'right' : 'left'
        break
      case 'help':
        this.overlay = { kind: 'help' }
        break
      case 'open':
        if (!this.busy) await this.toggleSelected()
        break
      case 'endpoint':
        if (!this.busy) this.openPicker()
        break
      case 'preview':
        if (!this.busy) await this.transferTo(true)
        break
      case 'sync':
        if (!this.busy) await this.transferTo(false)
        break
      case 'filter':
        if (!this.busy) this.filtering = this.active
        break
      case 'sort':
        if (!this.busy) this.cycleSort()
        break
      default:
        break
    }
    this.invalidate()
  }

  // ----------------------------------------------------------------- state

  private get current(): Pane {
    return this.panes[this.active]
  }

  private get other(): Pane {
    return this.panes[this.active === 'left' ? 'right' : 'left']
  }

  private say(text: string, tone: Tone = 'info'): void {
    this.status = { text, tone }
  }

  private async session(connection: Connection): Promise<SshSession> {
    const existing = this.sessions.get(connection.id)
    if (existing) return existing

    try {
      const session = await SshSession.connect(connection, {
        knownHostsPath: knownHostsPath(),
        // Without this the first connection to any host fails with "not in
        // known_hosts and DiskPush was not given a way to ask about it" — true,
        // and useless: the answer is a keystroke away.
        onUnknownHostKey: (details) =>
          new Promise<boolean>((resolve) => {
            this.overlay = {
              kind: 'hostKey',
              host: details.host,
              fingerprint: details.fingerprint,
              keyType: details.keyType,
              decide: (trust) => {
                this.overlay = null
                resolve(trust)
              },
            }
            this.invalidate()
          }),
      })
      this.sessions.set(connection.id, session)
      return session
    } finally {
      // A connect that fails leaves its question on screen with nobody behind
      // it. That is not a cosmetic leftover: the prompt owns the keyboard while
      // it is up, so every key goes to a `decide` whose promise no one awaits
      // any more -- arrows do nothing, and `q` does not quit. It is reached by
      // simply not answering: readyTimeout fires after connectTimeoutSeconds,
      // the connect rejects with "Timed out while waiting for handshake", and
      // the question outlives the asker. The pane shows an error and the app
      // looks frozen. Whoever asked is gone, so the question goes with them.
      if (this.overlay?.kind === 'hostKey') {
        this.overlay = null
        this.invalidate()
      }
    }
  }

  async load(side: Side): Promise<void> {
    const pane = this.panes[side]
    pane.error = null
    pane.loading = true
    this.invalidate()
    resetTree(pane)
    try {
      pane.entries = pane.connection ? await this.listRemote(pane, pane.path) : listLocal(pane.path)
      pane.index = 0
      pane.offset = 0
    } catch (error) {
      pane.entries = []
      pane.error = error instanceof Error ? error.message : String(error)
    } finally {
      pane.loading = false
      this.invalidate()
    }
  }

  async loadBoth(): Promise<void> {
    await this.load('left')
    await this.load('right')
  }

  private async listRemote(pane: Pane, path: string): Promise<Entry[]> {
    const browser = await SftpBrowser.open(await this.session(pane.connection!))
    try {
      const entries = await browser.list(path)
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.type === 'directory',
        size: entry.size,
        modifiedAt: entry.modifiedAt ?? null,
      }))
    } finally {
      browser.close()
    }
  }

  // ------------------------------------------------------------------ keys

  /** Returns false when the app should exit. */
  async onKey(key: KeyEvent): Promise<boolean> {
    if (key.key === 'ctrl+c') return false

    if (this.overlay?.kind === 'hostKey') return this.onHostKeyKey(key, this.overlay)
    if (this.overlay?.kind === 'help') {
      if (key.name === 'q') return false
      this.overlay = null
      return true
    }
    if (this.overlay?.kind === 'picker') return this.onPickerKey(key, this.overlay)
    if (this.filtering) return this.onFilterKey(key)

    // A message is about the last thing that happened; the next key starts
    // something new, so it stops being the answer to anything.
    this.status = null

    if (key.name === 'escape') {
      // Escape belongs to the transfer while there is one: cancelling a sync in
      // flight, or clearing the panel a finished one left behind.
      if (this.transfer) {
        this.dismissTransfer()
        return true
      }
      return false
    }
    if (key.name === 'q') return false
    if (this.busy) return true

    const pane = this.current
    const page = Math.max(1, (this.app?.height ?? 30) - 10)

    switch (true) {
      case key.name === 'tab':
        this.active = this.active === 'left' ? 'right' : 'left'
        break
      case key.name === 'up' || key.name === 'k':
        this.move(-1)
        break
      case key.name === 'down' || key.name === 'j':
        this.move(1)
        break
      case key.name === 'pageup':
        this.move(-page)
        break
      case key.name === 'pagedown':
        this.move(page)
        break
      case key.name === 'home':
        pane.index = 0
        break
      case key.name === 'end':
        pane.index = Math.max(0, visibleRows(pane).length - 1)
        break
      case key.name === 'left' || key.name === 'h':
        await this.foldOrGoUp()
        break
      case key.name === 'enter':
        await this.toggleSelected()
        break
      case key.name === 'right' || key.name === 'l':
        await this.unfoldOrStepIn()
        break
      case key.name === 'c':
        this.openPicker()
        break
      case key.name === 'r':
        await this.load(this.active)
        break
      case key.name === '/':
        this.filtering = this.active
        break
      // A shifted letter arrives as its own character with `shift` unset, so
      // the two sort keys are told apart by case rather than by the modifier.
      case key.char === 'o':
        this.cycleSort()
        break
      case key.char === 'O':
        pane.descending = !pane.descending
        clampIndex(pane)
        this.say(`Sorted by ${pane.sort}, ${pane.descending ? 'descending' : 'ascending'}`)
        break
      case key.char === '.':
        pane.showHidden = !pane.showHidden
        clampIndex(pane)
        this.say(pane.showHidden ? 'Showing hidden files' : 'Hiding hidden files')
        break
      case key.name === 'p':
        await this.transferTo(true)
        break
      case key.name === 's':
        await this.transferTo(false)
        break
      case key.name === '?':
        this.overlay = { kind: 'help' }
        break
      default:
        break
    }
    return true
  }

  private onHostKeyKey(key: KeyEvent, overlay: Extract<Overlay, { kind: 'hostKey' }>): boolean {
    // Quit stays reachable from inside the prompt. Every other key is
    // deliberately swallowed here -- a fingerprint is not something to dismiss
    // by mashing -- but a dialog that can trap you in the app is worse than one
    // you can leave, and `q` is the quit key everywhere else.
    if (key.name === 'q') return false
    if (key.name === 'y') overlay.decide(true)
    else if (key.name === 'escape' || key.name === 'n' || key.name === 'enter') overlay.decide(false)
    return true
  }

  private async onPickerKey(key: KeyEvent, picker: Extract<Overlay, { kind: 'picker' }>): Promise<boolean> {
    const matches = filterChoices(this.choices, picker.query)

    // Escape closes the picker rather than the app: inside a dialog it means
    // "not this", which is not the same as "quit".
    if (key.name === 'escape') {
      this.overlay = null
    } else if (key.name === 'up') {
      picker.index = Math.max(0, picker.index - 1)
    } else if (key.name === 'down') {
      picker.index = Math.min(Math.max(0, matches.length - 1), picker.index + 1)
    } else if (key.name === 'backspace') {
      picker.query = picker.query.slice(0, -1)
      picker.index = 0
    } else if (key.name === 'enter') {
      const choice = matches[picker.index]
      this.overlay = null
      if (choice) await this.choose(choice)
    } else if (key.char && !key.ctrl && !key.alt) {
      // Every printable key types into the query, which is why the picker binds
      // no letter shortcuts of its own — j and k are host names here.
      picker.query += key.char
      picker.index = 0
    }
    return true
  }

  private onFilterKey(key: KeyEvent): boolean {
    const pane = this.panes[this.filtering!]
    if (key.name === 'escape') {
      pane.filter = ''
      this.filtering = null
    } else if (key.name === 'enter') {
      this.filtering = null
    } else if (key.name === 'backspace') {
      pane.filter = pane.filter.slice(0, -1)
    } else if (key.char && !key.ctrl && !key.alt) {
      pane.filter += key.char
    }
    clampIndex(pane)
    return true
  }

  private move(delta: number): void {
    const pane = this.current
    const last = Math.max(0, visibleRows(pane).length - 1)
    pane.index = Math.min(last, Math.max(0, pane.index + delta))
  }

  // ------------------------------------------------------------------ tree

  /** Folds or unfolds a directory row, listing it first if it never has been. */
  private async toggle(side: Side, row: Row): Promise<void> {
    const pane = this.panes[side]
    if (!row.entry.isDirectory) return
    if (row.unfolded) {
      pane.unfolded.delete(row.rel)
      clampIndex(pane)
      this.invalidate()
      return
    }
    if (!pane.children.has(row.rel)) {
      if (pane.listing.has(row.rel)) return
      pane.listing.add(row.rel)
      this.invalidate()
      try {
        pane.children.set(row.rel, await this.listBelow(pane, row.rel))
      } catch (error) {
        this.say(`${row.rel}: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return
      } finally {
        pane.listing.delete(row.rel)
        this.invalidate()
      }
    }
    pane.unfolded.add(row.rel)
    this.invalidate()
  }

  private listBelow(pane: Pane, rel: string): Promise<Entry[]> {
    if (pane.connection) return this.listRemote(pane, posix.join(pane.path, rel))
    return Promise.resolve(listLocal(join(pane.path, rel)))
  }

  private async toggleSelected(): Promise<void> {
    const row = selectedRow(this.current)
    if (row) await this.toggle(this.active, row)
  }

  /** → on a folded directory unfolds it; on an unfolded one it steps onto the first child. */
  private async unfoldOrStepIn(): Promise<void> {
    const pane = this.current
    const row = selectedRow(pane)
    if (!row?.entry.isDirectory) return
    if (!row.unfolded) {
      await this.toggle(this.active, row)
      return
    }
    if (row.children.length > 0) pane.index += 1
  }

  /** ← folds the directory under the cursor, else climbs to its parent row, else leaves the root. */
  private async foldOrGoUp(): Promise<void> {
    const pane = this.current
    const row = selectedRow(pane)
    if (row?.entry.isDirectory && row.unfolded) {
      await this.toggle(this.active, row)
      return
    }
    if (row && row.depth > 0) {
      const rows = visibleRows(pane)
      for (let i = pane.index - 1; i >= 0; i -= 1) {
        if (rows[i]!.depth < row.depth) {
          pane.index = i
          return
        }
      }
    }
    await this.goUp()
  }

  private cycleSort(): void {
    const pane = this.current
    const next = SORT_KEYS[(SORT_KEYS.indexOf(pane.sort) + 1) % SORT_KEYS.length] as SortKey
    pane.sort = next
    clampIndex(pane)
    this.say(`Sorted by ${next}`)
  }

  // -------------------------------------------------------------- endpoints

  private openPicker(): void {
    if (this.choices.length === 0) {
      this.say('No servers configured. Add one with: diskpush connections add NAME user@host', 'warn')
      return
    }
    const current = this.current.connection
    const at = this.choices.findIndex((choice) =>
      current ? choice.connection?.name === current.name : choice.connection === null,
    )
    this.overlay = { kind: 'picker', query: '', index: at >= 0 ? at : 0 }
  }

  /** Points the active pane at the chosen endpoint and lists it. */
  private async choose(choice: EndpointChoice): Promise<void> {
    const pane = this.current
    pane.label = choice.label
    pane.connection = choice.connection
    pane.path = choice.path
    pane.entries = []
    pane.index = 0
    pane.offset = 0
    pane.filter = ''
    pane.error = null

    this.busy = true
    this.say(`Connecting to ${choice.label}…`)
    try {
      await this.load(this.active)
      this.status = pane.error ? { text: pane.error, tone: 'error' } : null
    } finally {
      this.busy = false
      this.invalidate()
    }
  }

  private async goUp(): Promise<void> {
    const pane = this.current
    const parent = parentPath(pane)
    if (parent === null) return
    pane.path = parent
    pane.filter = ''
    await this.load(this.active)
  }

  // -------------------------------------------------------------- transfers

  private dismissTransfer(): void {
    if (!this.transfer) return
    if (this.transfer.running) {
      this.transfer.cancel()
      this.say('Cancelling…', 'warn')
      return
    }
    this.transfer = null
  }

  private async transferTo(previewOnly: boolean): Promise<void> {
    const source = this.current
    const destination = this.other
    const controller = new AbortController()

    const transfer: Transfer = {
      mode: previewOnly ? 'preview' : 'sync',
      from: endpointString(source),
      to: endpointString(destination),
      running: true,
      progress: null,
      recent: [],
      summary: { add: 0, update: 0, metadata: 0, delete: 0, unchanged: 0, error: 0 },
      outcome: null,
      cancel: () => controller.abort(),
    }
    this.transfer = transfer
    this.busy = true
    this.invalidate()

    try {
      const remote = source.connection ?? destination.connection
      const plan = planTransfer({
        source: parseEndpoint(transfer.from),
        destination: parseEndpoint(transfer.to),
        options: defaultRsyncOptions({ dryRun: previewOnly, stats: true }),
        ...(remote ? { remoteShell: { keyPath: remote.keyPath, port: remote.port } } : {}),
      })

      const result = await runToCompletion(plan, { signal: controller.signal }, (event) => {
        if (event.type === 'change') pushChange(transfer, event.change as Change)
        else if (event.type === 'progress') transfer.progress = event.progress
        this.invalidate()
      })

      transfer.running = false
      const moved = transfer.summary.add + transfer.summary.update

      if (!result.ok) {
        transfer.outcome = { ok: false, message: result.message }
        this.say(result.message, 'error')
      } else if (previewOnly) {
        transfer.outcome = { ok: true, message: 'Preview complete' }
        this.say(
          `Preview: ${transfer.summary.add} to add, ${transfer.summary.update} to update, ${transfer.summary.unchanged} unchanged`,
          'ok',
        )
      } else {
        transfer.outcome = { ok: true, message: 'Sync complete' }
        this.say(`Synced ${moved} file${moved === 1 ? '' : 's'}`, 'ok')
        await this.load(this.active === 'left' ? 'right' : 'left')
      }
    } catch (error) {
      transfer.running = false
      const message = error instanceof Error ? error.message : String(error)
      transfer.outcome = { ok: false, message }
      this.say(message, 'error')
    } finally {
      transfer.running = false
      this.busy = false
      this.invalidate()
    }
  }

  close(): void {
    this.transfer?.cancel()
    for (const session of this.sessions.values()) session.close()
  }
}

function endpointString(pane: Pane): string {
  const path = pane.path.endsWith('/') ? pane.path : `${pane.path}/`
  if (!pane.connection) return path
  return `${pane.connection.username}@${pane.connection.host}:${path}`
}
