'use client'

/**
 * What you had typed, kept across a restart.
 *
 * Keeping both tabs mounted stops a tab switch from wiping the Fleet view, but
 * quitting the app still would, and a fifty-line script is not something to
 * lose to a window close. This is the unsaved draft — the thing you have not
 * decided to name yet. A *saved* command is the deliberate act; this is the
 * safety net under it.
 *
 * `localStorage`, not the database: it is per-machine UI state, it must be
 * readable synchronously during the first render (an async round trip would
 * paint an empty editor and then replace what you were looking at), and it
 * carries nothing anyone would want in a backup.
 */

const KEY = 'diskpush:fleet-draft:v1'

export type FleetDraft = {
  script: string
  interpreter: 'sh' | 'bash' | 'raw'
  sudo: boolean
  concurrency: number
  timeoutSeconds: number
  stopOnError: boolean
  label: string
  /** Connection ids. Ones that no longer exist are dropped on read. */
  selected: string[]
}

export const EMPTY_DRAFT: FleetDraft = {
  script: '',
  interpreter: 'raw',
  sudo: false,
  concurrency: 4,
  timeoutSeconds: 900,
  stopOnError: false,
  label: '',
  selected: [],
}

/**
 * Reads the draft, and is not allowed to fail.
 *
 * Storage throws outright in some contexts, and anything in there is last
 * week's shape after a schema change. A draft that cannot be restored is a
 * blank editor, never a broken window.
 */
export function readDraft(): FleetDraft {
  if (typeof window === 'undefined') return EMPTY_DRAFT
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return EMPTY_DRAFT
    const parsed = JSON.parse(raw) as Partial<FleetDraft>
    return {
      script: typeof parsed.script === 'string' ? parsed.script : EMPTY_DRAFT.script,
      interpreter:
        parsed.interpreter === 'sh' || parsed.interpreter === 'bash' || parsed.interpreter === 'raw'
          ? parsed.interpreter
          : EMPTY_DRAFT.interpreter,
      sudo: typeof parsed.sudo === 'boolean' ? parsed.sudo : EMPTY_DRAFT.sudo,
      concurrency: positive(parsed.concurrency, EMPTY_DRAFT.concurrency),
      timeoutSeconds: positive(parsed.timeoutSeconds, EMPTY_DRAFT.timeoutSeconds),
      stopOnError: typeof parsed.stopOnError === 'boolean' ? parsed.stopOnError : EMPTY_DRAFT.stopOnError,
      label: typeof parsed.label === 'string' ? parsed.label : EMPTY_DRAFT.label,
      selected: Array.isArray(parsed.selected) ? parsed.selected.filter((id) => typeof id === 'string') : [],
    }
  } catch {
    return EMPTY_DRAFT
  }
}

/** Writes the draft. Also cannot fail: losing a draft must not break a run. */
export function writeDraft(draft: FleetDraft): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(draft))
  } catch {
    // A private window, cleared site data, or storage disabled. The editor
    // still works; it just will not be there next time.
  }
}

export function clearDraft(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* see writeDraft */
  }
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
