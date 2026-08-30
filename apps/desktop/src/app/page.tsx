'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FileDown,
  MonitorOff,
  Plus,
  Settings,
  Users,
  X,
} from 'lucide-react'
import { ConnectionDialog } from '@/components/connection-dialog'
import { endpointLabel, loadPane, Pane, type PaneEndpoint, type PaneState } from '@/components/pane'
import { TransferRail } from '@/components/transfer-rail'
import { MirrorPreviewDialog, TransferBand, type ActiveJob } from '@/components/transfer-panel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, unwrap, type Connection, type PreviewResult, type TransferEvent } from '@/lib/api'
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
  const [trust, setTrust] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [job, setJob] = useState<ActiveJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showConnection, setShowConnection] = useState(false)
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

  const source = direction === 'ltr' ? left : right
  const destination = direction === 'ltr' ? right : left
  const allConnections = useMemo(() => [...saved, ...sshConfig], [saved, sshConfig])
  const route = `${endpointLabel(source.endpoint, allConnections)} → ${endpointLabel(destination.endpoint, allConnections)}`

  const request = useMemo(
    () => ({
      // The panes show directory contents, so a sync between them means "make
      // these contents match", not "nest this directory inside that one".
      source: refFor(source, withTrailingSlash(source.path)),
      destination: refFor(destination, withTrailingSlash(destination.path)),
      options: { deleteMode: mirror ? ('delay' as const) : ('off' as const) },
      deletesConfirmed: false,
    }),
    [source, destination, mirror],
  )

  const runPreview = useCallback(async () => {
    setError(null)
    setPreview(null)
    setPreviewOpen(true)
    try {
      setPreview(await unwrap(api()?.transfers.preview(request)))
    } catch (caught) {
      setPreviewOpen(false)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [request])

  const start = useCallback(
    async (deletesConfirmed: boolean) => {
      setError(null)
      setPreviewOpen(false)
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
    [request],
  )

  const run = useCallback(async () => {
    // Mirror always previews. A plain sync does not: its dry run costs a full
    // scan and buys no safety, because nothing is deleted either way.
    if (mirror) await runPreview()
    else await start(false)
  }, [mirror, runPreview, start])

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
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowConnection(true)}
            className="h-[var(--control)] gap-2 border-line-strong text-[12px]"
          >
            <Users className="size-3.5" />
            New server
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
                onClick={() => setShowConnection(true)}
                label="Add a server…"
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

      <div className="flex min-h-0 flex-1 gap-0 p-3.5">
        <Pane
          role="Source"
          state={left}
          saved={saved}
          sshConfig={sshConfig}
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
          onPreview={runPreview}
          onRun={run}
        />

        <Pane
          role="Destination"
          state={right}
          saved={saved}
          sshConfig={sshConfig}
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

      <ConnectionDialog open={showConnection} onClose={() => setShowConnection(false)} onSaved={() => void refreshConnections()} />

      <MirrorPreviewDialog
        preview={preview}
        open={previewOpen}
        route={route}
        trust={trust}
        onTrustChange={setTrust}
        onCancel={() => setPreviewOpen(false)}
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
