import type { PaneEndpoint } from '@/components/endpoint-select'
import type { PaneState } from '@/components/pane'

/**
 * Pane construction and the "should this pane load?" rule, kept out of
 * page.tsx so the rule can be tested.
 *
 * The panes start as placeholders until the shell has said where home is and
 * which connection to open. That used to be signalled by the path being `/`,
 * which stopped being safe once a bucket (whose root IS `/`) or "This computer"
 * at `/` became something a pane could legitimately be pointed at: the load
 * effect skipped it and the pane sat on its skeleton forever. Initialisation
 * is now its own flag.
 */

/** A pane pointed somewhere real. It loads as soon as it is set. */
export const blankPane = (endpoint: PaneEndpoint, path: string): PaneState => ({
  endpoint,
  path,
  entries: [],
  selected: new Set(),
  loading: true,
  error: null,
  transfersDisabled: false,
  initialised: true,
})

/** The pane shown before the shell has answered. It never loads by itself. */
export const placeholderPane = (): PaneState => ({ ...blankPane({ kind: 'local' }, '/'), initialised: false })

export function shouldLoadPane(pane: Pick<PaneState, 'initialised'>, outsideShell: boolean): boolean {
  return !outsideShell && pane.initialised
}
