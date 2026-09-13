/**
 * The whole screen, as one pure function of a snapshot.
 *
 * Nothing here touches the terminal, ssh or rsync: give it a `ViewState` and it
 * describes a frame. That is what lets `view.test.ts` assert on real rendered
 * text with no pty, and what keeps the app class down to state and effects.
 */
import type { Color, Container, Rect, Theme } from '@profullstack/hqtui'
import { stringWidth, truncate, widgets } from '@profullstack/hqtui'
import type { Change } from '@diskpush/schemas'
import {
  type Document,
  type EndpointChoice,
  type Overlay,
  type Pane,
  type Row,
  type Side,
  type Transfer,
  estimateRemaining,
  formatDuration,
  formatSize,
  formatWhen,
  isTruncated,
  nothingToDo,
  parentPath,
  rowTree,
  visibleEntries,
} from './model.js'
import { documentLines, maxScroll } from './document.js'

/** What hqtui's tree draws: the model's `Row`, spelled the widget's way. */
type TreeNode = {
  label: string
  color?: Color
  values?: { text: string; width: number; color?: Color; align?: 'left' | 'right' | 'center' }[]
  children?: TreeNode[]
  expanded?: boolean
}

export type Tone = 'info' | 'ok' | 'warn' | 'error'

export type ViewState = {
  panes: Record<Side, Pane>
  active: Side
  overlay: Overlay | null
  transfer: Transfer | null
  /** The file open under the panes, if any. */
  document: Document | null
  /** Which pane's `/` prompt is being typed into, if any. */
  filtering: Side | null
  status: { text: string; tone: Tone } | null
  choices: readonly EndpointChoice[]
  now: Date
}

/**
 * Something a key in the footer, or in the header, stands for. A click on the
 * key cap does what pressing the key does, through the same code, so the two
 * can never disagree.
 */
export type Action =
  | 'pane'
  | 'open'
  | 'endpoint'
  | 'view'
  | 'closeDocument'
  | 'edit'
  | 'openWith'
  | 'preview'
  | 'sync'
  | 'filter'
  | 'sort'
  | 'help'
  | 'quit'
  | 'cancelTransfer'
  | 'dismissTransfer'
  | 'closeOverlay'

/**
 * Mouse wiring. Optional so a test can render a frame without any.
 *
 * Rows are reported as an index into the pane's *visible rows*, never as a
 * screen row: the tree scrolls, and only the frame that drew it knows where
 * its window started, so the frame does the arithmetic.
 */
export type ViewHandlers = {
  onPaneFocus?: (side: Side) => void
  /** A click on a row: select it, and fold or unfold it if it is a directory. */
  onSelectRow?: (side: Side, index: number) => void
  /** A click on the `..` row. */
  onGoUp?: (side: Side) => void
  /** The pointer is over a row (-1 is `..`), or left the rows (null). */
  onHoverRow?: (side: Side, index: number | null) => void
  onScroll?: (side: Side, delta: number) => void
  /** A click on a key cap in the footer or the header. */
  onAction?: (action: Action) => void
  /** A click on a row of the endpoint picker: point the pane there. */
  onPickChoice?: (choice: EndpointChoice) => void
  /** A click on a dialog's backdrop, or its close button. */
  onDismissOverlay?: () => void
  /** A click on one of the host-key question's answers. */
  onHostKeyDecide?: (trust: boolean) => void
  /** The wheel over the open document, or a click on its scrollbar. */
  onDocumentScroll?: (delta: number) => void
  /**
   * What the frame drew of the document: how many lines it has and how many
   * of them fit. Only the frame knows either, and the app needs both to clamp
   * a scroll before the next frame rather than after it.
   */
  onDocumentLayout?: (total: number, rows: number) => void
  /**
   * Where an image should be drawn, in screen cells. The frame leaves the
   * cells blank; the app hands the terminal the image after the frame is
   * out, because an image is not a cell and no framebuffer can hold it.
   */
  onImageRect?: (rect: Rect) => void
}

/** Rows the transfer panel takes when one is on screen. */
const TRANSFER_HEIGHT = 9

/** Rows of the document panel that are border rather than document. */
const DOCUMENT_CHROME = 2

/**
 * Rows the panes keep while a document is open under them.
 *
 * The panes are how you got to the file and how you pick the next one, so
 * they stay; the document is what you asked to look at, so it gets the larger
 * share. A short terminal still leaves the panes enough rows to be a listing,
 * and the document enough to be more than a title.
 */
export function paneRowsBeside(height: number): number {
  // The header and the footer take a row each.
  const usable = height - 2
  const panes = Math.max(6, Math.floor(usable * 0.38))
  return Math.min(panes, Math.max(4, usable - DOCUMENT_CHROME - 4))
}

const ACTION_LEVEL: Record<Change['action'], string> = {
  add: 'ADD',
  update: 'UPD',
  metadata: 'META',
  delete: 'DEL',
  unchanged: 'SAME',
  error: 'ERR',
}

export function toneColor(theme: Theme, tone: Tone): Color {
  if (tone === 'ok') return theme.success
  if (tone === 'warn') return theme.warning
  if (tone === 'error') return theme.danger
  return theme.info
}

/**
 * Shortens a path from the left.
 *
 * `truncate` keeps the head, which is right for a label and wrong for a path:
 * `/home/anthony/src/profullstack/…` names nobody's directory, while the tail
 * is exactly the part that identifies it.
 */
export function truncatePath(path: string, to: number): string {
  if (to <= 0) return ''
  if (stringWidth(path) <= to) return path
  if (to === 1) return '…'
  let out = ''
  let used = 1
  const characters = [...path]
  for (let i = characters.length - 1; i >= 0; i -= 1) {
    const width = stringWidth(characters[i]!)
    if (used + width > to) break
    out = characters[i]! + out
    used += width
  }
  return `…${out}`
}

/** The picker's live filter: substring over both the name and the detail line. */
export function filterChoices(choices: readonly EndpointChoice[], query: string): EndpointChoice[] {
  if (query.trim() === '') return [...choices]
  const needle = query.trim().toLowerCase()
  return choices.filter(
    (choice) => choice.label.toLowerCase().includes(needle) || choice.detail.toLowerCase().includes(needle),
  )
}

export function draw(
  ui: Container,
  theme: Theme,
  width: number,
  height: number,
  state: ViewState,
  handlers: ViewHandlers = {},
): void {
  drawHeader(ui, theme, state, handlers)

  // With a document open the panes give up most of the screen to it, which
  // is the ask: the listing stays where it was, and the file opens under it.
  ui.row({ gap: 0, height: state.document ? paneRowsBeside(height) : 'fill' }, (row) => {
    drawPane(row, theme, state, 'left', Math.floor(width / 2), handlers)
    drawPane(row, theme, state, 'right', Math.floor(width / 2), handlers)
  })

  if (state.document) drawDocument(ui, theme, state.document, width, height, handlers)
  // A short terminal gives its rows to the panes; the transfer is still
  // readable from the status line, and half a panel is worse than none.
  else if (state.transfer && height >= TRANSFER_HEIGHT + 8) drawTransfer(ui, theme, state, state.transfer, handlers)

  drawFooter(ui, theme, state, width, handlers)

  if (state.overlay?.kind === 'picker') drawPicker(ui, theme, state, state.overlay, height, handlers)
  if (state.overlay?.kind === 'help') drawHelp(ui, theme, handlers)
  if (state.overlay?.kind === 'hostKey') drawHostKey(ui, theme, state.overlay, width, handlers)
}

function drawHeader(ui: Container, theme: Theme, state: ViewState, handlers: ViewHandlers): void {
  const source = state.panes[state.active]
  const destination = state.panes[state.active === 'left' ? 'right' : 'left']
  const arrow = state.active === 'left' ? '→' : '←'
  const direction =
    state.active === 'left' ? `${source.label} ${arrow} ${destination.label}` : `${destination.label} ${arrow} ${source.label}`

  ui.statusBar({
    height: 1,
    keyStyle: 'plain',
    background: theme.surface,
    items: [
      { label: 'DiskPush', color: theme.primary, active: true },
      { label: 'two-pane rsync browser', color: theme.muted },
    ],
    right: [
      // The direction is the active pane spelled out, so clicking it does what
      // tab does: it is the one place the sync direction is visible.
      { label: direction, color: theme.accent, onPress: () => handlers.onAction?.('pane') },
      { key: '?', label: 'help', color: theme.muted, onPress: () => handlers.onAction?.('help') },
    ],
  })
}

function drawPane(
  row: Container,
  theme: Theme,
  state: ViewState,
  side: Side,
  paneWidth: number,
  handlers: ViewHandlers,
): void {
  const pane = state.panes[side]
  const active = side === state.active
  const entries = visibleEntries(pane)
  const files = entries.filter((entry) => !entry.isDirectory)
  const bytes = files.reduce((total, entry) => total + entry.size, 0)
  // `..` sits above the tree whenever there is somewhere to go. It is not one
  // of the rows, so the cursor index counts from the first real row. A
  // listing that failed keeps it too: the way out of a directory that cannot
  // be read must not be keyboard-only.
  const parent = parentPath(pane) !== null
  const tree = pane.error ? [] : rowTree(pane)
  const shift = parent ? 1 : 0
  const column = (text: string, width: number) => ({ text, width, color: theme.muted })
  const toNode = (row: Row): TreeNode => ({
    // The marker is the fold state, and it changes under the click: ▸ folded,
    // ▾ unfolded, … while the listing is on its way.
    label: `${row.entry.isDirectory ? (row.listing ? '…' : row.unfolded ? '▾' : '▸') : ' '} ${row.entry.name}`,
    color: row.entry.isDirectory ? theme.primary : theme.foreground,
    expanded: row.unfolded,
    ...(row.unfolded ? { children: row.children.map(toNode) } : {}),
    values: [
      column(row.entry.isDirectory ? '—' : formatSize(row.entry.size), 7),
      column(formatWhen(row.entry.modifiedAt, state.now), 8),
    ],
  })
  const nodes: TreeNode[] = [
    ...(parent ? [{ label: '↑ ..', color: theme.muted, values: [column('', 7), column('', 8)] }] : []),
    ...tree.map(toNode),
  ]

  const kind = pane.connection ? '◈' : '▪'
  const title = ` ${kind} ${pane.label} `
  // Title and path share the top border row, and the box gives the path
  // priority: a path budgeted against the full pane width squeezes the title
  // down to an ellipsis on one side and is dropped whole on the other, so which
  // half of the header you lose comes down to a one-column rounding difference.
  // Budgeting it against what the title leaves keeps both.
  const pathRoom = Math.max(12, paneWidth - stringWidth(title) - 8)
  const sortMark = pane.descending ? '▼' : '▲'
  const footerParts = [
    `${entries.length} item${entries.length === 1 ? '' : 's'}`,
    files.length > 0 ? formatSize(bytes) : '',
    `${pane.sort}${sortMark}`,
    pane.showHidden ? 'hidden' : '',
    pane.filter ? `/${pane.filter}` : '',
  ].filter(Boolean)

  row.panel(
    {
      width: '1fr',
      focused: active,
      title,
      titleColor: active ? theme.primary : theme.muted,
      subtitle: truncatePath(pane.path, pathRoom),
      subtitleColor: theme.muted,
      footer: ` ${footerParts.join('  ·  ')} `,
      // The border, the title, the space under a short listing: a click on any
      // of it lands in this pane, so this pane becomes the one the keys act on.
      onClick: () => handlers.onPaneFocus?.(side),
    },
    (panel) => {
      if (pane.loading) {
        panel.spacer(1)
        panel.text('Connecting…', { align: 'center', fg: theme.muted })
        return
      }
      // Where the tree's window started, as of this frame. A click reports
      // the row it landed on counted from the top of that window.
      let first = 0
      const indexOf = (visibleRow: number) => first + visibleRow - shift

      if (nodes.length > 0) {
        panel.tree({
          nodes,
          selected: pane.index + shift,
          hovered: pane.hover === null ? undefined : pane.hover + shift,
          followSelection: true,
          scrollbar: true,
          // Indent alone shows the nesting; the ▸ ▾ markers carry the fold
          // state, and connector lines would make `..` look like a sibling.
          guides: false,
          // An empty or unreadable directory still shows its `..`, on one
          // row, with the explanation underneath rather than a screen of nothing.
          ...(tree.length === 0 ? { size: nodes.length } : {}),
          onFocus: () => handlers.onPaneFocus?.(side),
          // One click does the thing: a directory folds or unfolds, a file is
          // selected, `..` goes up.
          onSelectRow: (visibleRow) => {
            const index = indexOf(visibleRow)
            if (index < 0) handlers.onGoUp?.(side)
            else handlers.onSelectRow?.(side, index)
          },
          onHoverRow: (visibleRow) => handlers.onHoverRow?.(side, visibleRow === null ? null : indexOf(visibleRow)),
          onScroll: (delta) => handlers.onScroll?.(side, delta),
          onRow: (_node, index, y) => {
            first = index - y
          },
        })
      }

      if (pane.error) {
        panel.spacer(1)
        panel.text(pane.error, { fg: theme.danger, wrap: true, align: 'center' })
      } else if (tree.length === 0) {
        panel.spacer(1)
        panel.text(pane.filter ? `Nothing matches “${pane.filter}”` : 'Empty', { align: 'center', fg: theme.muted })
      }
    },
  )
}

/**
 * The open file, under the panes.
 *
 * Markdown is drawn rendered, text as numbered lines, a binary as a hex dump
 * of its head; `documentLines` decides which. The panel's footer says where
 * in the file you are and how much of it was read, because the viewer reads a
 * head and not the file, and a listing that ends is not the same as a file
 * that does.
 */
function drawDocument(
  ui: Container,
  theme: Theme,
  doc: Document,
  width: number,
  height: number,
  handlers: ViewHandlers,
): void {
  const title = ` ${doc.name} `
  // The border and its padding take two columns a side; the scrollbar one more.
  const textWidth = Math.max(10, width - 5)
  const lines = doc.loading || doc.error ? [] : documentLines(doc, textWidth, theme)
  // A hex dump is the viewer admitting defeat, so it says what would work;
  // an image says what it is, because the terminal may draw nothing at all.
  const hint =
    doc.kind === 'binary'
      ? 'Not a text file. e edits it; x opens it with a player, a viewer or the desktop.'
      : doc.kind === 'image' && doc.image
        ? `${doc.image.format.toUpperCase()} ${doc.image.width}×${doc.image.height}. Drawn below when the terminal can (WezTerm, kitty, iTerm2, Konsole); x opens it elsewhere.`
        : null
  const rows = Math.max(1, height - 2 - paneRowsBeside(height) - DOCUMENT_CHROME - (hint ? 1 : 0))
  const scroll = Math.min(doc.scroll, maxScroll(lines.length, rows))
  const scrolls = lines.length > rows
  handlers.onDocumentLayout?.(lines.length, rows)

  const last = Math.min(lines.length, scroll + rows)
  const footerParts = [
    lines.length > 0 ? `lines ${scroll + 1}–${last} of ${lines.length}` : '',
    doc.kind === 'image' && doc.image ? `${doc.image.width}×${doc.image.height}` : '',
    doc.loading || doc.error ? '' : doc.kind,
    doc.loading
      ? ''
      : isTruncated(doc)
        ? `first ${formatSize(doc.bytes.length)} of ${formatSize(doc.size)}`
        : formatSize(doc.size),
  ].filter(Boolean)

  ui.panel(
    {
      height: 'fill',
      title,
      titleColor: theme.primary,
      subtitle: truncatePath(doc.location, Math.max(12, width - stringWidth(title) - 8)),
      subtitleColor: theme.muted,
      footer: footerParts.length > 0 ? ` ${footerParts.join('  ·  ')} ` : undefined,
    },
    (panel) => {
      if (doc.loading) {
        panel.spacer(1)
        panel.text('Reading…', { align: 'center', fg: theme.muted })
        return
      }
      if (doc.error) {
        panel.spacer(1)
        panel.text(doc.error, { fg: theme.danger, wrap: true, align: 'center' })
        return
      }
      if (doc.kind === 'image') {
        if (hint) panel.text(hint, { height: 1, fg: theme.muted })
        // Blank on purpose: the image goes here, after the frame.
        panel.draw((surface) => handlers.onImageRect?.(surface.hitRect()), { height: 'fill' })
        return
      }
      if (lines.length === 0) {
        panel.spacer(1)
        panel.text('Empty file', { align: 'center', fg: theme.muted })
        return
      }
      if (hint) panel.text(hint, { height: 1, fg: theme.muted })
      panel.row({ gap: 0, height: 'fill' }, (row) => {
        row.draw(
          (surface) => {
            widgets.drawText(surface, lines, { scroll })
            // `text` claims no region of its own, so the wheel over the
            // document is wired here: the same scroll the bar beside it does.
            row.ctx.hit({ rect: surface.hitRect(), onScroll: (delta) => handlers.onDocumentScroll?.(delta) })
          },
          { width: '1fr' },
        )
        // A bar whose thumb fills the track says nothing; a file that fits gets none.
        if (scrolls) {
          row.scrollbar({
            width: 1,
            total: lines.length,
            viewport: rows,
            offset: scroll,
            onScroll: (delta) => handlers.onDocumentScroll?.(delta),
          })
        }
      })
    },
  )
}

function drawTransfer(ui: Container, theme: Theme, state: ViewState, transfer: Transfer, handlers: ViewHandlers): void {
  const progress = transfer.progress
  const preview = transfer.mode === 'preview'
  const cancelled = transfer.outcome?.cancelled === true
  const failed = transfer.outcome !== null && !transfer.outcome.ok && !cancelled
  const idle = nothingToDo(transfer)
  // rsync's last progress line is whatever it happened to print before it
  // exited — 80% on a sync that finished. A completed transfer is 100%.
  const percent = transfer.outcome?.ok ? 100 : (progress?.percent ?? 0)
  const remaining = preview ? null : estimateRemaining(progress)
  // The clock runs off the wall, not off rsync: a dry run over a big tree can
  // say nothing for a minute, and a panel that stops counting looks dead.
  const elapsed = Math.max(0, ((transfer.endedAt ?? state.now.getTime()) - transfer.startedAt) / 1000)

  const title = transfer.running
    ? ` ${preview ? 'Scanning' : 'Syncing'} ${transfer.what} `
    : cancelled
      ? ' Cancelled '
      : transfer.outcome?.ok
        ? idle && preview
          ? ' Already in sync '
          : ` ${preview ? 'Preview' : 'Sync'} complete `
        : ' Failed '
  const titleColor = transfer.running || cancelled ? theme.warning : transfer.outcome?.ok ? theme.success : theme.danger

  ui.panel(
    {
      height: TRANSFER_HEIGHT,
      title,
      titleColor,
      subtitle: truncatePath(`${transfer.from}  →  ${transfer.to}`, 60),
      subtitleColor: theme.muted,
      borderColor: titleColor,
      footer: transfer.running ? ' esc  cancel ' : ' esc  dismiss ',
      // A finished transfer is dismissed by clicking it. A running one is not
      // cancelled that way: cancelling a sync from a stray click is exactly
      // the kind of accident this program exists to avoid, so that stays on
      // the key bar, where it is spelled out.
      ...(transfer.running ? {} : { onClick: () => handlers.onAction?.('dismissTransfer') }),
    },
    (panel) => {
      if (preview) {
        // A dry run moves no bytes, so its percentage is 0 until the end by
        // definition. What moves is the count of files checked.
        const scanned = transfer.scanned
        const value = transfer.outcome?.ok ? 1 : scanned && scanned.total > 0 ? scanned.checked / scanned.total : 0
        const text = scanned
          ? `${transfer.outcome?.ok ? scanned.total : scanned.checked}/${scanned.total} files`
          : transfer.running
            ? 'scanning…'
            : ''
        panel.meter({
          height: 1,
          value: Math.max(0, Math.min(1, value)),
          label: 'checked',
          text,
          heat: false,
          color: failed ? theme.danger : cancelled ? theme.warning : theme.primary,
        })
      } else {
        panel.meter({
          height: 1,
          value: Math.max(0, Math.min(1, percent / 100)),
          label: 'copy',
          text: `${percent.toFixed(0)}%`,
          heat: false,
          color: failed ? theme.danger : cancelled ? theme.warning : theme.primary,
        })
      }

      panel.row({ height: 1, gap: 1 }, (row) => {
        if (preview) {
          const found = transfer.summary.add + transfer.summary.update + transfer.summary.delete
          row.text(`  ${found} change${found === 1 ? '' : 's'} found so far`, { fg: theme.muted })
        } else {
          const rate = progress && progress.bytesPerSecond > 0 ? `${formatSize(progress.bytesPerSecond)}/s` : '—'
          const moved = progress ? formatSize(progress.bytesTransferred) : '—'
          const files = progress?.filesTransferred != null ? String(progress.filesTransferred) : '—'
          row.text(`  ${moved}  ·  ${rate}  ·  ${files} files`, { fg: theme.muted })
        }
        row.text(
          remaining != null ? `${formatDuration(remaining)} left  ` : `${formatDuration(elapsed)}  `,
          { fg: theme.muted, align: 'right' },
        )
      })

      panel.row({ height: 1, gap: 1 }, (row) => {
        const { add, update, metadata, delete: removed, unchanged, error } = transfer.summary
        // Along a row every child fills by default, which spreads six short
        // badges across the whole panel. Each one is sized to its own text so
        // they read as a group.
        const badge = (text: string, color: Color, variant: 'subtle' | 'filled' = 'subtle') =>
          row.badge({ text, color, variant, width: text.length + 2 })
        badge(`+${add}`, theme.success)
        badge(`~${update}`, theme.info)
        badge(`=${unchanged}`, theme.muted)
        if (metadata > 0) badge(`meta ${metadata}`, theme.muted)
        if (removed > 0) badge(`-${removed}`, theme.warning)
        if (error > 0) badge(`err ${error}`, theme.danger, 'filled')
        row.spacer('fill')
      })

      if (cancelled) {
        panel.text(`${transfer.outcome!.message} It was stopped by esc; nothing on either side was changed by stopping it.`, {
          fg: theme.warning,
          wrap: true,
        })
        return
      }
      if (failed) {
        panel.text(transfer.outcome!.message, { fg: theme.danger, wrap: true })
        return
      }
      if (idle) {
        const total = transfer.scanned?.total
        panel.text(
          `Nothing to do: ${total != null ? `${total} files checked, ` : ''}the other side already matches.`,
          { fg: theme.muted, wrap: true },
        )
        return
      }

      panel.log({
        height: 'fill',
        follow: true,
        entries: transfer.recent.map((change) => ({
          level: ACTION_LEVEL[change.action],
          message: change.path,
          meta: change.size != null && !change.isDirectory ? formatSize(change.size) : '',
        })),
        levelColors: {
          ADD: theme.success,
          UPD: theme.info,
          META: theme.muted,
          DEL: theme.warning,
          SAME: theme.muted,
          ERR: theme.danger,
        },
      })
    },
  )
}

function drawFooter(ui: Container, theme: Theme, state: ViewState, width: number, handlers: ViewHandlers): void {
  // The filter prompt replaces the key bar while it is being typed: the keys it
  // would list are all characters going into the filter.
  if (state.filtering) {
    ui.textInput({
      height: 1,
      label: 'filter',
      value: state.panes[state.filtering].filter,
      placeholder: 'type to narrow, enter to keep, esc to clear',
      focused: true,
      width,
    })
    return
  }

  if (state.status) {
    ui.statusBar({
      height: 1,
      background: theme.surface,
      items: [{ label: truncate(state.status.text, width - 2), color: toneColor(theme, state.status.tone), active: true }],
    })
    return
  }

  // Each key cap is also a button for the same action. While a dialog is up
  // its backdrop takes every click, so the bar under it only needs to read
  // right; the dialog's own buttons are the ones that answer.
  const act = (action: Action) => () => handlers.onAction?.(action)
  const overlay = state.overlay?.kind
  const items =
    overlay === 'picker'
      ? [
          { key: '↑↓', label: 'move' },
          { key: '⏎', label: 'select' },
          { key: 'type', label: 'filter' },
          { key: 'esc', label: 'cancel' },
        ]
      : overlay === 'hostKey'
        ? [
            { key: 'y', label: 'trust' },
            { key: 'n', label: 'cancel' },
            { key: 'q', label: 'quit' },
          ]
        : overlay === 'help'
          ? [{ key: 'esc', label: 'close' }]
          : state.transfer?.running
            ? [
                // Every other key is ignored while a transfer runs, so the bar
                // says so instead of listing keys that would do nothing.
                { key: 'esc', label: 'cancel', onPress: act('cancelTransfer') },
                { key: 'q', label: 'quit', onPress: act('quit') },
              ]
            : state.document
              ? [
                  // The panes keep the arrows, so the document follows the
                  // cursor from file to file; paging is what the viewer owns.
                  { key: 'tab', label: 'pane', onPress: act('pane') },
                  { key: '↑↓', label: 'file' },
                  { key: 'pgdn pgup', label: 'page' },
                  { key: 'g G', label: 'top end' },
                  { key: 'e', label: 'edit', onPress: act('edit') },
                  { key: 'x', label: 'open…', onPress: act('openWith') },
                  { key: 'esc', label: 'close', onPress: act('closeDocument') },
                  { key: 'q', label: 'quit', onPress: act('quit') },
                ]
              : [
                { key: 'tab', label: 'pane', onPress: act('pane') },
                { key: '⏎', label: 'open', onPress: act('open') },
                { key: 'v', label: 'view', onPress: act('view') },
                { key: 'e', label: 'edit', onPress: act('edit') },
                { key: 'x', label: 'open…', onPress: act('openWith') },
                { key: 'c', label: 'endpoint', onPress: act('endpoint') },
                { key: 'p', label: 'preview', onPress: act('preview') },
                { key: 's', label: 'sync', onPress: act('sync') },
                { key: '/', label: 'filter', onPress: act('filter') },
                { key: 'o', label: 'sort', onPress: act('sort') },
                { key: 'q', label: 'quit', onPress: act('quit') },
              ]

  ui.statusBar({ height: 1, keyStyle: 'caps', items })
}

function drawPicker(
  ui: Container,
  theme: Theme,
  state: ViewState,
  overlay: Extract<Overlay, { kind: 'picker' }>,
  height: number,
  handlers: ViewHandlers,
): void {
  const matches = filterChoices(state.choices, overlay.query)
  // Built from a modal rather than `commandPalette`, whose title is fixed at
  // "Command Palette" — this is a list of your servers, and saying so is the
  // whole point of the dialog.
  const rows = Math.max(3, Math.min(matches.length, height - 12))
  let first = 0
  ui.modal(
    { title: ' Point this pane at ', width: 62, height: rows + 6, onDismiss: () => handlers.onDismissOverlay?.() },
    (modal) => {
    modal.textInput({
      height: 1,
      value: overlay.query,
      placeholder: 'type to filter servers',
      focused: true,
    })
    modal.divider({ height: 1, color: theme.border })
    if (matches.length === 0) {
      modal.text('No server matches that.', { fg: theme.muted, align: 'center' })
      return
    }
      modal.table({
        rows: matches,
        selected: overlay.index,
        followSelection: true,
        scrollbar: true,
        header: false,
        height: 'fill',
        // This is a menu: one click chooses. Selecting and then confirming is
        // what the keyboard does because it has to type a filter first.
        onSelectRow: (visibleRow) => {
          const choice = matches[first + visibleRow]
          if (choice) handlers.onPickChoice?.(choice)
        },
        onRow: (_choice, index, y) => {
          first = index - y
        },
        columns: [
          { key: 'label', width: '1fr', color: theme.foreground },
          { key: 'detail', align: 'right', color: theme.muted },
        ],
      })
    },
  )
}

function drawHelp(ui: Container, theme: Theme, handlers: ViewHandlers): void {
  const close = () => handlers.onDismissOverlay?.()
  ui.modal(
    {
      title: ' Keys ',
      width: 66,
      height: 28,
      buttons: [{ label: 'esc  close', variant: 'ghost', onPress: close }],
      onDismiss: close,
    },
    (modal) => {
      modal.keyValues(
        [
          { label: 'tab', value: 'switch pane' },
          { label: '↑ ↓ / j k', value: 'move' },
          { label: '⏎ / → / l', value: 'unfold a directory' },
          { label: '← / h', value: 'fold it, or go up' },
          { label: 'pgup pgdn home end', value: 'jump' },
          { label: 'click', value: 'select; fold or unfold a directory' },
          { label: 'click ..', value: 'go up' },
          { label: 'v, or ⏎ on a file', value: 'view it under the panes; ↑ ↓ then follow' },
          { label: 'pgdn pgup g G', value: 'page the open file, jump to its ends' },
          { label: 'e', value: 'edit it in $EDITOR: a tmux window, or here' },
          { label: 'x', value: 'open it with a player, a viewer or the desktop' },
          { label: 'c', value: 'point this pane somewhere else' },
          { label: '/', value: 'filter this listing' },
          { label: 'o / O', value: 'cycle sort / reverse it' },
          { label: '.', value: 'show hidden files' },
          { label: 'r', value: 'reload' },
          { label: 'p', value: 'preview syncing this to the other pane' },
          { label: 's', value: 'sync it, into the same place over there' },
          { label: 'esc', value: 'cancel a transfer, close a file or this' },
          { label: 'q', value: 'quit' },
        ],
        { labelColor: theme.accent },
      )
      modal.text('No Mirror: deleting files from a keystroke, with no delete list on screen, is the accident DiskPush exists to prevent.', {
        fg: theme.muted,
        wrap: true,
      })
      modal.spacer('fill')
    },
  )
}

function drawHostKey(
  ui: Container,
  theme: Theme,
  overlay: Extract<Overlay, { kind: 'hostKey' }>,
  width: number,
  handlers: ViewHandlers,
): void {
  ui.modal(
    {
      title: ` Unknown host: ${overlay.host} `,
      width: Math.min(72, Math.max(44, width - 8)),
      height: 11,
      color: theme.warning,
      // No onDismiss: a fingerprint is not something a stray click answers.
      buttons: [
        { label: 'y  trust', variant: 'warning', focused: true, onPress: () => handlers.onHostKeyDecide?.(true) },
        { label: 'n  cancel', variant: 'ghost', onPress: () => handlers.onHostKeyDecide?.(false) },
      ],
    },
    (modal) => {
      modal.text(`${overlay.keyType} key fingerprint:`)
      modal.text(overlay.fingerprint, { fg: theme.warning, bold: true, wrap: true })
      modal.spacer(1)
      modal.text('Compare it with the server before trusting it.', { fg: theme.muted, wrap: true })
    },
  )
}
