'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import {
  ArrowLeftRight,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FileDown,
  MonitorOff,
  Plus,
  Server,
  Settings,
  Users,
  X,
} from 'lucide-react'
import { ConnectionDialog } from '@/components/connection-dialog'
import { FleetView } from '@/components/fleet-view'
import { ProfileBar } from '@/components/profile-bar'
import { ServerManager } from '@/components/server-manager'
import { endpointLabel, loadPane, Pane, type PaneEndpoint, type PaneState } from '@/components/pane'
import { TransferRail } from '@/components/transfer-rail'
import { TransferBand, TransferPreviewDialog, type ActiveJob } from '@/components/transfer-panel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  unwrap,
  type Connection,
  type PreviewProgress,
  type PreviewResult,
  type SyncProfile,
  type TransferEvent,
} from '@/lib/api'
import { withTrailingSlash } from '@/lib/format'

/** A row in the header menu. Plain button, styled once. */
function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] text-dim transition-colors hover:bg-secondary hover:text-foreground"
    >
      <span className="text-faint">{icon}</span>
      {label}
    </button>
  )
}

/** One of the two top-level views. A segmented control, not a link. */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`focus-ring flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

/** What the renderer sends to preview or start a transfer. */
type TransferDraft = {
  source: ReturnType<typeof refFor>
  destination: ReturnType<typeof refFor>
  options: { deleteMode: 'off' | 'delay' }
  deletesConfirmed: boolean
  selection: string[]
}

const blankPane = (endpoint: PaneEndpoint, path: string): PaneState => ({
  endpoint,
  path,
  entries: [],
  selected: new Set(),
  loading: true,
  error: null,
  transfersDisabled: false,
})

export default function Workspace() {
  const [saved, setSaved] = useState<Connection[]>([])
  const [sshConfig, setSshConfig] = useState<Connection[]>([])
  const [left, setLeft] = useState<PaneState>(blankPane({ kind: 'local' }, '/'))
  const [right, setRight] = useState<PaneState>(blankPane({ kind: 'local' }, '/'))
  const [active, setActive] = useState<'left' | 'right'>('left')
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr')
  const [mirror, setMirror] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewProgress, setPreviewProgress] = useState<PreviewProgress | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  /**
   * The scan the dialog is currently showing.
   *
   * A preview cannot be identified by "the one that is running", because
   * stopping one and starting another leaves both in flight: the first call
   * still resolves, and without this it would paint its delete list over the
   * second one's route. Confirming that would mirror a pair the user never
   * saw. Every result and every progress event is matched against this id.
   */
  const previewIdRef = useRef<string | null>(null)
  /**
   * The request the open preview was built from.
   *
   * Confirming runs THIS, not a request rebuilt from whatever the panes say by
   * then. A dialog that says "delete 12 files" has to start the transfer it
   * measured, even if something changed a pane underneath it.
   */
  const approvedRequestRef = useRef<TransferDraft | null>(null)
  const [job, setJob] = useState<ActiveJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showConnection, setShowConnection] = useState(false)
  const [showServers, setShowServers] = useState(false)
  const [tab, setTab] = useState<'transfer' | 'fleet'>('transfer')
  const [profiles, setProfiles] = useState<SyncProfile[]>([])
  const [outsideShell, setOutsideShell] = useState(false)

  const refreshConnections = useCallback(async () => {
    try {
      setSaved(await unwrap(api()?.connections.list()))
      setSshConfig(await unwrap(api()?.connections.sshConfigHosts()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const importSshConfig = useCallback(async () => {
    setError(null)
    try {
      const imported = await unwrap(api()?.connections.importSshConfig())
      if (imported.length === 0) setError('No importable hosts found in ~/.ssh/config.')
      else await refreshConnections()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [refreshConnections])

  useEffect(() => {
    if (!api()) {
      setOutsideShell(true)
      return
    }
    void (async () => {
      const home = await unwrap(api()?.fs.homeLocal())
      setLeft(blankPane({ kind: 'local' }, home))

      // The right pane used to open on local too, so DiskPush launched as a
      // two-pane view of the same directory twice -- a local file manager,
      // which is the one job this is not for. Open on a server when there is
      // one, so the window arrives in the state the tool exists to be in.
      // Saved connections come first: they were configured deliberately, where
      // an ssh_config host is only something that happens to be on the box.
      const [savedList, hosts] = await Promise.all([
        unwrap(api()?.connections.list()),
        unwrap(api()?.connections.sshConfigHosts()),
      ])
      setSaved(savedList)
      setSshConfig(hosts)
      setProfiles(await unwrap(api()?.profiles.list()))

      const first = savedList[0] ?? hosts[0]
      setRight(
        first
          ? blankPane({ kind: 'ssh', connectionId: first.id }, first.defaultRemotePath ?? '.')
          : blankPane({ kind: 'local' }, home),
      )
    })().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [refreshConnections])

  const navigate = useCallback(async (side: 'left' | 'right', endpoint: PaneEndpoint, path: string) => {
    const set = side === 'left' ? setLeft : setRight
    set((current) => ({ ...current, endpoint, path, loading: true, error: null, selected: new Set() }))
    try {
      const result = await loadPane(endpoint, path)
      set((current) => ({ ...current, path: result.path, entries: result.entries, loading: false }))
    } catch (caught) {
      set((current) => ({
        ...current,
        loading: false,
        entries: [],
        error: caught instanceof Error ? caught.message : String(caught),
      }))
    }
  }, [])

  useEffect(() => {
    if (outsideShell || left.path === '/') return
    void navigate('left', left.endpoint, left.path)
    // Endpoint changes reload; path changes go through navigate itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left.endpoint])

  useEffect(() => {
    if (outsideShell || right.path === '/') return
    void navigate('right', right.endpoint, right.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [right.endpoint])

  useEffect(() => {
    const bridge = api()
    if (!bridge) return
    return bridge.events.onTransfer(({ jobId, event }) => setJob((current) => reduceJob(current, jobId, event)))
  }, [])

  useEffect(() => {
    const bridge = api()
    if (!bridge) return
    return bridge.events.onPreview(({ previewId, progress }) => {
      if (previewId !== previewIdRef.current) return
      setPreviewProgress(progress)
    })
  }, [])

  const source = direction === 'ltr' ? left : right
  const destination = direction === 'ltr' ? right : left
  const allConnections = useMemo(() => [...saved, ...sshConfig], [saved, sshConfig])
  const route = `${endpointLabel(source.endpoint, allConnections)} → ${endpointLabel(destination.endpoint, allConnections)}`

  /**
   * The transfer for a given direction.
   *
   * It takes the direction rather than reading it, because the rail sets the
   * direction and starts the transfer in the same click. `setDirection` does
   * not change the value this render already closed over, so a request built
   * from state ran the PREVIOUS direction: pressing "Sync to Local" while the
   * other arrow was armed copied local over the server instead, and with
   * Mirror on it would have deleted the wrong side.
   */
  const requestFor = useCallback(
    (towards: 'ltr' | 'rtl'): TransferDraft => {
      const from = towards === 'ltr' ? left : right
      const to = towards === 'ltr' ? right : left
      return {
        // The panes show directory contents, so a sync between them means "make
        // these contents match", not "nest this directory inside that one".
        source: refFor(from, withTrailingSlash(from.path)),
        destination: refFor(to, withTrailingSlash(to.path)),
        options: { deleteMode: mirror ? ('delay' as const) : ('off' as const) },
        deletesConfirmed: false,
        // What the user ticked in the pane the files come FROM. Empty means the
        // whole directory.
        selection: [...from.selected],
      }
    },
    [left, right, mirror],
  )

  /**
   * Closes the dialog and stops the scan behind it.
   *
   * Closing used to only hide the dialog. The rsync dry run carried on to the
   * end -- minutes of a remote tree walk nobody could see or interrupt -- and
   * then resolved into a dialog that was no longer open.
   */
  const closePreview = useCallback(() => {
    const previewId = previewIdRef.current
    previewIdRef.current = null
    setPreviewOpen(false)
    setPreviewProgress(null)
    if (previewId) void api()?.transfers.cancelPreview(previewId)
  }, [])

  const runPreview = useCallback(async (towards: 'ltr' | 'rtl') => {
    const request = requestFor(towards)
    approvedRequestRef.current = request
    const previewId = crypto.randomUUID()
    // Supersedes any scan already running, so pressing Preview twice does not
    // leave two rsync processes walking the same trees.
    const superseded = previewIdRef.current
    if (superseded) void api()?.transfers.cancelPreview(superseded)

    previewIdRef.current = previewId
    setError(null)
    setPreview(null)
    setPreviewProgress(null)
    setPreviewOpen(true)
    try {
      const result = await unwrap(api()?.transfers.preview({ ...request, previewId }))
      if (previewIdRef.current !== previewId) return
      // A scan the user stopped is not a result. Showing it would offer a
      // confirm button for a delete list that was never finished.
      if (result.cancelled) return
      setPreview(result)
    } catch (caught) {
      if (previewIdRef.current !== previewId) return
      previewIdRef.current = null
      setPreviewOpen(false)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [requestFor])

  const start = useCallback(
    async (deletesConfirmed: boolean) => {
      const request = approvedRequestRef.current
      if (!request) return
      setError(null)
      previewIdRef.current = null
      setPreviewOpen(false)
      setPreviewProgress(null)
      try {
        const started = await unwrap(api()?.transfers.start({ ...request, deletesConfirmed }))
        setJob({
          jobId: started.jobId,
          percent: 0,
          bytesTransferred: 0,
          bytesPerSecond: 0,
          files: 0,
          currentFile: '',
          elapsedSeconds: 0,
          finished: false,
          resumable: false,
          message: '',
        })
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [],
  )

  /**
   * Restores a saved pair.
   *
   * The panes are set from the stored endpoints; Mirror follows the stored
   * delete mode, because a profile that quietly left Mirror as you found it
   * would be a profile that does something different every time.
   */
  const loadProfile = useCallback(
    (profile: SyncProfile) => {
      const toPane = (endpoint: SyncProfile['source']): PaneEndpoint =>
        endpoint.type === 'local' || !endpoint.connectionId
          ? { kind: 'local' }
          : { kind: 'ssh', connectionId: endpoint.connectionId }

      setError(null)

      /*
       * Put each pane back where it was, not where the transfer's direction
       * happens to imply.
       *
       * `source` and `destination` carry the transfer's meaning, so with the
       * arrow pointing right-to-left the source IS the right pane. Loading
       * source into the left pane unconditionally mirrored the whole window,
       * and forcing the arrow back to left-to-right lost the direction too.
       */
      const sourceOnLeft = (profile.sourcePane ?? 'left') === 'left'
      const forLeft = sourceOnLeft ? profile.source : profile.destination
      const forRight = sourceOnLeft ? profile.destination : profile.source

      setLeft(blankPane(toPane(forLeft), forLeft.path))
      setRight(blankPane(toPane(forRight), forRight.path))
      setDirection(sourceOnLeft ? 'ltr' : 'rtl')
      setMirror(profile.options?.deleteMode !== undefined && profile.options.deleteMode !== 'off')
    },
    [],
  )

  const saveProfile = useCallback(
    async (name: string) => {
      setError(null)
      // A profile stores the pair and its options. Not the selection: a saved
      // pair is meant to be re-runnable later, and a list of entry names that
      // were ticked once is not a thing that stays true.
      const request = requestFor(direction)
      try {
        await unwrap(
          api()?.profiles.save({
            name,
            source: request.source,
            destination: request.destination,
            options: request.options,
            // Which pane the source was on. Without it, loading cannot tell a
            // right-to-left arrangement from a mirrored left-to-right one.
            sourcePane: direction === 'ltr' ? 'left' : 'right',
          }),
        )
        setProfiles(await unwrap(api()?.profiles.list()))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [requestFor, direction],
  )

  const removeProfile = useCallback(async (id: string) => {
    setError(null)
    try {
      await unwrap(api()?.profiles.remove(id))
      setProfiles(await unwrap(api()?.profiles.list()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  /**
   * Every manual transfer is previewed and approved. Mirror is not special.
   *
   * This used to start a plain sync immediately, on the reasoning that a dry
   * run "buys no safety, because nothing is deleted either way". Deleting is
   * not the only way to regret a transfer: the run that prompted this change
   * was two selected folders that turned into forty thousand files, and by the
   * time anything is on screen it is already copying. Now the same dialog that
   * guards a mirror shows what a sync would do, and nothing starts until it is
   * approved.
   *
   * The direction is passed in rather than read: the rail sets it and runs in
   * one click, and the state has not updated yet.
   */
  const run = useCallback(
    async (towards: 'ltr' | 'rtl') => {
      await runPreview(towards)
    },
    [runPreview],
  )

  if (outsideShell) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="elevation-panel max-w-md rounded-xl border border-line bg-card p-5 text-center">
          <span className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-secondary text-faint">
            <MonitorOff className="size-[18px]" />
          </span>
          <p className="text-[13px] font-medium text-dim">Not running in the desktop shell</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            This is the DiskPush renderer. It needs the desktop shell, which provides the filesystem and transfer
            bridge.
          </p>
        </div>
      </div>
    )
  }

  const connected = saved.length + sshConfig.length
  const rsyncFlags = [
    'rsync --archive --partial-dir=.rsync-partial --info=progress2',
    mirror ? '--delete-delay' : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[72px] shrink-0 items-center gap-3.5 border-b border-line bg-chrome px-4">
        {/*
          Two files, not one. logo.dark.png is the lockup FOR a dark background:
          its "Disk" is white, so on the light theme it vanished and the header
          read a lone blue "Push". Swapped by media query rather than by reading
          the scheme in JS, so it is right in the first paint and never flips.
        */}
        <Image
          src="/logo.dark.png"
          alt="DiskPush"
          width={2172}
          height={724}
          className="hidden h-auto w-[150px] dark:block"
          priority
        />
        <Image
          src="/logo.png"
          alt="DiskPush"
          width={2172}
          height={724}
          className="block h-auto w-[150px] dark:hidden"
          priority
        />
        <div className="h-5 w-px bg-line" />
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {connected > 0 ? (
            <CircleCheck className="size-3.5 text-ok" />
          ) : (
            <CircleAlert className="size-3.5 text-warn" />
          )}
          {connected > 0 ? (
            <>
              <span className="numeric font-medium text-foreground">{connected}</span>
              <span>server{connected === 1 ? '' : 's'} available</span>
            </>
          ) : (
            <span>No servers yet</span>
          )}
        </div>
        {/*
          Two views, not a dialog. Fleet is somewhere you work for minutes with
          a long script in front of you, which is the opposite of what a modal
          is for -- and as a modal its Run button ended up below the fold.
        */}
        <nav className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5">
          <TabButton active={tab === 'transfer'} onClick={() => setTab('transfer')}>
            <ArrowLeftRight className="size-3.5" />
            Transfer
          </TabButton>
          <TabButton active={tab === 'fleet'} onClick={() => setTab('fleet')}>
            <Server className="size-3.5" />
            Fleet
          </TabButton>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowServers(true)}
            className="h-[var(--control)] gap-2 border-line-strong text-[12px]"
          >
            <Users className="size-3.5" />
            Servers
          </Button>

          {/*
            This gear had no onClick at all -- a control in the top-right corner
            of the window that did nothing when pressed, which on its own is
            enough to make an app feel half-built. It now opens the two actions
            that already exist behind the bridge, plus the project link.
          */}
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  aria-label="Menu"
                  className="size-[var(--control)] border-line-strong p-0 text-muted-foreground"
                />
              }
            >
              <Settings className="size-[15px]" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[236px] gap-0.5 p-1.5">
              <MenuItem
                icon={<Plus className="size-3.5" />}
                onClick={() => setShowServers(true)}
                label="Servers…"
              />
              <MenuItem
                icon={<FileDown className="size-3.5" />}
                onClick={() => void importSshConfig()}
                label="Import from ~/.ssh/config"
              />
              <div className="my-1 h-px bg-line" />
              <MenuItem
                icon={<ExternalLink className="size-3.5" />}
                onClick={() => void api()?.shell.openExternal('https://diskpush.com')}
                label="diskpush.com"
              />
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {error ? (
        <div className="flex shrink-0 items-start gap-2.5 border-b border-danger-line bg-danger-surface px-4 py-2.5 text-[12px] text-danger-ink">
          <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
          <span className="selectable min-w-0 flex-1">{error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setError(null)}
            className="focus-ring -mr-1 shrink-0 rounded p-0.5 text-danger-ink/70 transition-colors hover:text-danger-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/*
        One view or the other, never both. The transfer side keeps its own
        footer and status band; Fleet brings its own, pinned so the action
        it exists for cannot scroll out of reach.
      */}
      {/*
        Both views stay MOUNTED, and the inactive one is hidden.

        This was a ternary, so switching tabs unmounted the other branch and
        React threw its state away: a half-written script, the servers you had
        ticked, the output of a run still going. Clicking Transfer to check a
        path and coming back to a blank Fleet view is not a tab, it is a
        reset.
      */}
      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'transfer' ? '' : 'hidden'}`}>
        <ProfileBar
          profiles={profiles}
          routeLabel={route}
          busy={job !== null && !job.finished}
          onLoad={loadProfile}
          onSave={(name) => void saveProfile(name)}
          onRemove={(id) => void removeProfile(id)}
        />
        <div className="flex min-h-0 flex-1 gap-0 p-3.5">
          <Pane
            role="Source"
            state={left}
            saved={saved}
            sshConfig={sshConfig}
            onRefreshHosts={refreshConnections}
            active={active === 'left'}
            onFocus={() => setActive('left')}
            onChange={(patch) => setLeft((current) => ({ ...current, ...patch }))}
            onNavigate={(path) => void navigate('left', left.endpoint, path)}
            onEndpointChange={(endpoint) => setLeft(blankPane(endpoint, defaultPathFor(endpoint, allConnections)))}
            onAddServer={() => setShowConnection(true)}
          />

          <TransferRail
            direction={direction}
            mirror={mirror}
            busy={job !== null && !job.finished}
            leftLabel={railLabel(left.endpoint, allConnections)}
            rightLabel={railLabel(right.endpoint, allConnections)}
            onDirection={setDirection}
            onToggleMirror={() => setMirror((value) => !value)}
            onPreview={() => void runPreview(direction)}
            onRun={(towards) => void run(towards)}
          />

          <Pane
            role="Destination"
            state={right}
            saved={saved}
            sshConfig={sshConfig}
            onRefreshHosts={refreshConnections}
            active={active === 'right'}
            onFocus={() => setActive('right')}
            onChange={(patch) => setRight((current) => ({ ...current, ...patch }))}
            onNavigate={(path) => void navigate('right', right.endpoint, path)}
            onEndpointChange={(endpoint) => setRight(blankPane(endpoint, defaultPathFor(endpoint, allConnections)))}
            onAddServer={() => setShowConnection(true)}
          />
        </div>

        <TransferBand
          job={job}
          route={route}
          mirror={mirror}
          onCancel={() => {
            if (job) void api()?.transfers.cancel(job.jobId)
          }}
        />

        {/*
          This line used to be a fixed string that read like the command being
          run but could not change -- turn Mirror on and it still claimed no
          deletes. A command line nobody can trust is worse than none, so it is
          built from the same state the transfer is.
        */}
        <footer className="flex h-[28px] shrink-0 items-center gap-2.5 border-t border-line bg-background px-4 text-[11px] text-faint">
          <span>Incremental</span>
          <span className="text-line-strong">·</span>
          <span>Archive metadata</span>
          <span className="text-line-strong">·</span>
          <span>Resume</span>
          <span className="text-line-strong">·</span>
          <span className={mirror ? 'font-medium text-destructive' : 'text-ok'}>Deletes {mirror ? 'ON' : 'off'}</span>
          {/*
            The command used to run flush to the window edge and get sliced
            mid-token by the truncation, so the last thing in the footer was
            always half a word. It keeps a gutter now, and the full string is in
            the tooltip.
          */}
          <span className="selectable numeric ml-auto min-w-0 max-w-[54%] truncate pl-4 text-[10.5px]" title={rsyncFlags}>
            {rsyncFlags}
          </span>
        </footer>
      </div>

      <div className={`flex min-h-0 flex-1 flex-col ${tab === 'fleet' ? '' : 'hidden'}`}>
        <FleetView onAddServer={() => setShowServers(true)} />
      </div>

      <ServerManager
        open={showServers}
        onClose={() => setShowServers(false)}
        onChanged={() => void refreshConnections()}
      />

      <ConnectionDialog open={showConnection} onClose={() => setShowConnection(false)} onSaved={() => void refreshConnections()} />

      <TransferPreviewDialog
        preview={preview}
        progress={previewProgress}
        open={previewOpen}
        route={route}
        mirror={mirror}
        selectionCount={approvedRequestRef.current?.selection.length ?? 0}
        onCancel={closePreview}
        onStopScan={closePreview}
        onConfirm={() => void start(true)}
      />
    </div>
  )
}

function refFor(pane: PaneState, path: string) {
  return pane.endpoint.kind === 'local'
    ? ({ type: 'local', path } as const)
    : ({ type: 'ssh', connectionId: pane.endpoint.connectionId, path } as const)
}

/**
 * "This computer" is right in a pane header and too long on an 84px button,
 * where it truncated to "to This comp...". The rail gets the short form; a
 * server keeps its own name, which is already short.
 */
function railLabel(endpoint: PaneEndpoint, connections: readonly Connection[]): string {
  return endpoint.kind === 'local' ? 'Local' : endpointLabel(endpoint, connections)
}

function defaultPathFor(endpoint: PaneEndpoint, connections: readonly Connection[]): string {
  if (endpoint.kind === 'local') return '/'
  const connection = connections.find((candidate) => candidate.id === endpoint.connectionId)
  return connection?.defaultRemotePath ?? '.'
}

function reduceJob(current: ActiveJob | null, jobId: string, event: TransferEvent): ActiveJob | null {
  if (!current || current.jobId !== jobId) return current
  switch (event.type) {
    case 'progress':
      return {
        ...current,
        percent: event.progress.percent,
        bytesTransferred: event.progress.bytesTransferred,
        bytesPerSecond: event.progress.bytesPerSecond,
        elapsedSeconds: event.progress.elapsedSeconds,
      }
    case 'change':
      return event.change.action === 'add' || event.change.action === 'update'
        ? { ...current, files: current.files + 1, currentFile: event.change.path }
        : current
    case 'exit':
      return {
        ...current,
        finished: true,
        percent: event.code === 0 || event.code === 24 ? 100 : current.percent,
        resumable: event.resumable,
        message: event.message,
      }
    default:
      return current
  }
}
