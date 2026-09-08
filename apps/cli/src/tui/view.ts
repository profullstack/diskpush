/**
 * The whole screen, as one pure function of a snapshot.
 *
 * Nothing here touches the terminal, ssh or rsync: give it a `ViewState` and it
 * describes a frame. That is what lets `view.test.ts` assert on real rendered
 * text with no pty, and what keeps the app class down to state and effects.
 */
import type { Color, Container, Theme } from '@profullstack/hqtui'
import { stringWidth, truncate } from '@profullstack/hqtui'
import type { Change } from '@diskpush/schemas'
import {
  type EndpointChoice,
  type Overlay,
  type Pane,
  type Side,
  type Transfer,
  estimateRemaining,
  formatDuration,
  formatSize,
  formatWhen,
  visibleEntries,
} from './model.js'

export type Tone = 'info' | 'ok' | 'warn' | 'error'

export type ViewState = {
  panes: Record<Side, Pane>
  active: Side
  overlay: Overlay | null
  transfer: Transfer | null
  /** Which pane's `/` prompt is being typed into, if any. */
  filtering: Side | null
  status: { text: string; tone: Tone } | null
  choices: readonly EndpointChoice[]
  now: Date
}

/** Mouse wiring. Optional so a test can render a frame without any. */
export type ViewHandlers = {
  onPaneFocus?: (side: Side) => void
  onSelectRow?: (side: Side, visibleRow: number) => void
  onScroll?: (side: Side, delta: number) => void
  /**
   * Every body row the table drew, with its screen row. A click reports the row
   * it landed on counted from the top of the visible window, and only the table
   * knows where that window starts — this is how the app finds out.
   */
  onRowDrawn?: (side: Side, index: number, y: number) => void
}

/** Rows the transfer panel takes when one is on screen. */
const TRANSFER_HEIGHT = 9

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
  drawHeader(ui, theme, state)

  ui.row({ gap: 0, height: 'fill' }, (row) => {
    drawPane(row, theme, state, 'left', Math.floor(width / 2), handlers)
    drawPane(row, theme, state, 'right', Math.floor(width / 2), handlers)
  })

  // A short terminal gives its rows to the panes; the transfer is still
  // readable from the status line, and half a panel is worse than none.
  if (state.transfer && height >= TRANSFER_HEIGHT + 8) drawTransfer(ui, theme, state.transfer)

  drawFooter(ui, theme, state, width)

  if (state.overlay?.kind === 'picker') drawPicker(ui, theme, state, state.overlay, height)
  if (state.overlay?.kind === 'help') drawHelp(ui, theme)
  if (state.overlay?.kind === 'hostKey') drawHostKey(ui, theme, state.overlay, width)
}

function drawHeader(ui: Container, theme: Theme, state: ViewState): void {
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
      { label: direction, color: theme.accent },
      { key: '?', label: 'help', color: theme.muted },
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
    },
    (panel) => {
      if (pane.loading) {
        panel.spacer(1)
        panel.text('Connecting…', { align: 'center', fg: theme.muted })
        return
      }
      if (pane.error) {
        panel.spacer(1)
        panel.text(pane.error, { fg: theme.danger, wrap: true, align: 'center' })
        return
      }
      if (entries.length === 0) {
        panel.spacer(1)
        panel.text(pane.filter ? `Nothing matches “${pane.filter}”` : 'Empty', { align: 'center', fg: theme.muted })
        return
      }

      panel.table({
        rows: entries,
        selected: pane.index,
        offset: pane.offset,
        followSelection: true,
        scrollbar: true,
        header: false,
        onFocus: () => handlers.onPaneFocus?.(side),
        onSelectRow: (visibleRow) => handlers.onSelectRow?.(side, visibleRow),
        onScroll: (delta) => handlers.onScroll?.(side, delta),
        onRow: (_entry, index, y) => handlers.onRowDrawn?.(side, index, y),
        columns: [
          {
            // Fills: the size and date belong against the right edge, not
            // floating in the middle of a wide pane behind a column of air.
            key: 'name',
            width: '1fr',
            render: (entry) => `${entry.isDirectory ? '▸' : ' '} ${entry.name}`,
            color: (entry) => (entry.isDirectory ? theme.primary : theme.foreground),
          },
          {
            key: 'size',
            width: 7,
            align: 'right',
            render: (entry) => (entry.isDirectory ? '—' : formatSize(entry.size)),
            color: theme.muted,
          },
          {
            key: 'modifiedAt',
            width: 8,
            align: 'right',
            render: (entry) => formatWhen(entry.modifiedAt, state.now),
            color: theme.muted,
          },
        ],
      })
    },
  )
}

function drawTransfer(ui: Container, theme: Theme, transfer: Transfer): void {
  const progress = transfer.progress
  // rsync's last progress line is whatever it happened to print before it
  // exited — 80% on a preview that finished. A completed transfer is 100%.
  const percent = transfer.outcome?.ok ? 100 : (progress?.percent ?? 0)
  const remaining = estimateRemaining(progress)
  const preview = transfer.mode === 'preview'

  const title = transfer.running
    ? ` ${preview ? 'Previewing' : 'Syncing'} `
    : transfer.outcome?.ok
      ? ` ${preview ? 'Preview' : 'Sync'} complete `
      : ' Failed '
  const titleColor = transfer.running ? theme.warning : transfer.outcome?.ok ? theme.success : theme.danger

  ui.panel(
    {
      height: TRANSFER_HEIGHT,
      title,
      titleColor,
      subtitle: truncatePath(`${transfer.from}  →  ${transfer.to}`, 60),
      subtitleColor: theme.muted,
      borderColor: titleColor,
      footer: transfer.running ? ' esc  cancel ' : ' esc  dismiss ',
    },
    (panel) => {
      panel.meter({
        height: 1,
        value: Math.max(0, Math.min(1, percent / 100)),
        label: preview ? 'scan' : 'copy',
        text: `${percent.toFixed(0)}%`,
        heat: false,
        color: transfer.outcome?.ok === false ? theme.danger : theme.primary,
      })

      panel.row({ height: 1, gap: 1 }, (row) => {
        const rate = progress && progress.bytesPerSecond > 0 ? `${formatSize(progress.bytesPerSecond)}/s` : '—'
        const moved = progress ? formatSize(progress.bytesTransferred) : '—'
        const files = progress?.filesTransferred != null ? String(progress.filesTransferred) : '—'
        row.text(`  ${moved}  ·  ${rate}  ·  ${files} files`, { fg: theme.muted })
        row.text(
          remaining != null ? `${formatDuration(remaining)} left  ` : progress ? `${formatDuration(progress.elapsedSeconds)}  ` : '',
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

      if (transfer.outcome && !transfer.outcome.ok) {
        panel.text(transfer.outcome.message, { fg: theme.danger, wrap: true })
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

function drawFooter(ui: Container, theme: Theme, state: ViewState, width: number): void {
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
          : [
              { key: 'tab', label: 'pane' },
              { key: '⏎', label: 'open' },
              { key: 'c', label: 'endpoint' },
              { key: 'p', label: 'preview' },
              { key: 's', label: 'sync' },
              { key: '/', label: 'filter' },
              { key: 'o', label: 'sort' },
              { key: 'q', label: 'quit' },
            ]

  ui.statusBar({ height: 1, keyStyle: 'caps', items })
}

function drawPicker(
  ui: Container,
  theme: Theme,
  state: ViewState,
  overlay: Extract<Overlay, { kind: 'picker' }>,
  height: number,
): void {
  const matches = filterChoices(state.choices, overlay.query)
  // Built from a modal rather than `commandPalette`, whose title is fixed at
  // "Command Palette" — this is a list of your servers, and saying so is the
  // whole point of the dialog.
  const rows = Math.max(3, Math.min(matches.length, height - 12))
  ui.modal({ title: ' Point this pane at ', width: 62, height: rows + 6 }, (modal) => {
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
      columns: [
        { key: 'label', width: '1fr', color: theme.foreground },
        { key: 'detail', align: 'right', color: theme.muted },
      ],
    })
  })
}

function drawHelp(ui: Container, theme: Theme): void {
  ui.modal({ title: ' Keys ', width: 58, height: 22 }, (modal) => {
    modal.keyValues(
      [
        { label: 'tab', value: 'switch pane' },
        { label: '↑ ↓ / j k', value: 'move' },
        { label: '⏎ / → / l', value: 'open directory' },
        { label: '← / h', value: 'go up' },
        { label: 'pgup pgdn home end', value: 'jump' },
        { label: 'c', value: 'point this pane somewhere else' },
        { label: '/', value: 'filter this listing' },
        { label: 'o / O', value: 'cycle sort / reverse it' },
        { label: '.', value: 'show hidden files' },
        { label: 'r', value: 'reload' },
        { label: 'p', value: 'preview a sync to the other pane' },
        { label: 's', value: 'sync to the other pane' },
        { label: 'esc', value: 'cancel a transfer, or close this' },
        { label: 'q', value: 'quit' },
      ],
      { labelColor: theme.accent },
    )
    modal.spacer('fill')
    modal.text('No Mirror: deleting files from a keystroke, with no delete list on screen, is the accident DiskPush exists to prevent.', {
      fg: theme.muted,
      wrap: true,
    })
  })
}

function drawHostKey(
  ui: Container,
  theme: Theme,
  overlay: Extract<Overlay, { kind: 'hostKey' }>,
  width: number,
): void {
  ui.modal(
    {
      title: ` Unknown host: ${overlay.host} `,
      width: Math.min(72, Math.max(44, width - 8)),
      height: 11,
      color: theme.warning,
      buttons: [
        { label: 'y  trust', variant: 'warning', focused: true },
        { label: 'n  cancel', variant: 'ghost' },
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
