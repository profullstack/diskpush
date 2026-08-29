'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConnectionDialog } from '@/components/connection-dialog'
import { Pane, endpointLabel, loadPane, type PaneEndpoint, type PaneState } from '@/components/pane'
import { MirrorPreviewDialog, TransferQueue, type ActiveJob } from '@/components/transfer-panel'
import { Banner, Button, Checkbox, Dialog } from '@/components/ui'
import { api, unwrap, type Connection, type PreviewResult, type TransferEvent } from '@/lib/api'
import { withTrailingSlash } from '@/lib/format'

const EMPTY_PANE = (endpoint: PaneEndpoint, path: string): PaneState => ({
  endpoint,
  path,
  entries: [],
  selected: new Set(),
  loading: true,
  error: null,
  transfersDisabled: false,
})

type Options = {
  archive: boolean
  checksum: boolean
  compression: 'auto' | 'zstd'
  hardLinks: boolean
  acls: boolean
  xattrs: boolean
  excludes: string[]
}

const DEFAULT_OPTIONS: Options = {
  archive: true,
  checksum: false,
  compression: 'auto',
  hardLinks: false,
  acls: false,
  xattrs: false,
  excludes: [],
}

export default function Workspace() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [left, setLeft] = useState<PaneState>(EMPTY_PANE({ kind: 'local' }, '/'))
  const [right, setRight] = useState<PaneState>(EMPTY_PANE({ kind: 'local' }, '/'))
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr')
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [mirrorMode, setMirrorMode] = useState(false)
  const [job, setJob] = useState<ActiveJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showConnection, setShowConnection] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [outsideShell, setOutsideShell] = useState(false)

  // --- bootstrap -----------------------------------------------------------

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await unwrap(api()?.connections.list()))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (!api()) {
      setOutsideShell(true)
      return
    }
    void (async () => {
      const home = await unwrap(api()?.fs.homeLocal())
      setLeft(EMPTY_PANE({ kind: 'local' }, home))
      setRight(EMPTY_PANE({ kind: 'local' }, home))
      await refreshConnections()
    })().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [refreshConnections])

  // --- pane loading --------------------------------------------------------

  const navigate = useCallback(
    async (side: 'left' | 'right', endpoint: PaneEndpoint, path: string) => {
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
    },
    [],
  )

  useEffect(() => {
    if (outsideShell || left.path === '/') return
    void navigate('left', left.endpoint, left.path)
    // Only re-run when the endpoint itself changes; path changes go through navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left.endpoint])

  useEffect(() => {
    if (outsideShell || right.path === '/') return
    void navigate('right', right.endpoint, right.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [right.endpoint])

  // --- job events ----------------------------------------------------------

  useEffect(() => {
    const bridge = api()
    if (!bridge) return
    return bridge.events.onTransfer(({ jobId, event }) => {
      setJob((current) => reduceJob(current, jobId, event))
    })
  }, [])

  // --- transfer ------------------------------------------------------------

  const source = direction === 'ltr' ? left : right
  const destination = direction === 'ltr' ? right : left

  const request = useMemo(
    () => ({
      // The trailing slash is added deliberately: the panes show directory
      // contents, so a sync between them means "make these contents match",
      // not "nest this directory inside that one".
      source: refFor(source, withTrailingSlash(source.path)),
      destination: refFor(destination, withTrailingSlash(destination.path)),
      options: {
        archive: options.archive,
        checksum: options.checksum,
        compression: options.compression,
        deleteMode: mirrorMode ? ('delay' as const) : ('off' as const),
        hardLinks: options.hardLinks,
        acls: options.acls,
        xattrs: options.xattrs,
        excludes: options.excludes,
      },
      deletesConfirmed: false,
    }),
    [source, destination, options, mirrorMode],
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

  const sync = useCallback(async () => {
    // Mirror always previews first. A plain sync does not, because its dry run
    // costs a full scan and buys no safety: nothing is deleted either way.
    if (mirrorMode) await runPreview()
    else await start(false)
  }, [mirrorMode, runPreview, start])

  if (outsideShell) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md">
          <Banner kind="info">
            This is the DiskPush renderer. It runs inside the desktop shell, which provides the
            filesystem and transfer bridge. Start it with <code className="font-mono">pnpm start</code> in
            apps/desktop.
          </Banner>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <span className="font-semibold tracking-tight">DiskPush</span>
        <span className="text-[11px] text-muted">Push files fast. Sync only what changed.</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => setShowConnection(true)}>New server</Button>
          <Button onClick={() => setShowOptions(true)}>Transfer options</Button>
        </div>
      </header>

      {error ? (
        <div className="px-3 pt-2">
          <Banner kind="danger">{error}</Banner>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-px bg-line p-px">
        <Pane
          title="Left: Local / Server 1"
          state={left}
          connections={connections}
          onChange={(patch) => setLeft((current) => ({ ...current, ...patch }))}
          onNavigate={(path) => void navigate('left', left.endpoint, path)}
          onEndpointChange={(endpoint) => setLeft(EMPTY_PANE(endpoint, defaultPathFor(endpoint, connections)))}
          onAddServer={() => setShowConnection(true)}
        />
        <Pane
          title="Right: Remote / Server 2"
          state={right}
          connections={connections}
          onChange={(patch) => setRight((current) => ({ ...current, ...patch }))}
          onNavigate={(path) => void navigate('right', right.endpoint, path)}
          onEndpointChange={(endpoint) => setRight(EMPTY_PANE(endpoint, defaultPathFor(endpoint, connections)))}
          onAddServer={() => setShowConnection(true)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-y border-line px-3 py-2">
        <span className="text-[11px] text-muted">
          Source: <strong className="text-text">{endpointLabel(source.endpoint, connections)}</strong> → Destination:{' '}
          <strong className="text-text">{endpointLabel(destination.endpoint, connections)}</strong>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => setDirection('ltr')} variant={direction === 'ltr' ? 'primary' : 'default'}>
            Sync →
          </Button>
          <Button onClick={() => setDirection('rtl')} variant={direction === 'rtl' ? 'primary' : 'default'}>
            ← Sync
          </Button>
          <Button onClick={runPreview}>Preview changes</Button>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={mirrorMode}
              onChange={(event) => setMirrorMode(event.target.checked)}
              className="accent-[var(--color-danger)]"
            />
            <span className={mirrorMode ? 'text-danger' : ''}>Mirror (deletes)</span>
          </label>
          <Button variant={mirrorMode ? 'danger' : 'primary'} onClick={sync} disabled={job !== null && !job.finished}>
            {mirrorMode ? 'Mirror…' : 'Run sync'}
          </Button>
        </div>
      </div>

      <div className="border-b border-line px-3 py-1 text-[11px] text-muted">
        Mode: {mirrorMode ? 'Mirror' : 'Incremental Sync'} · Archive metadata: {options.archive ? 'On' : 'Off'} ·
        Resume partial transfers: On · Skip unchanged files: {options.checksum ? 'By checksum' : 'On'} ·
        Delete destination-only files: {mirrorMode ? 'On' : 'Off'}
      </div>

      <TransferQueue
        job={job}
        onCancel={() => {
          if (job) void api()?.transfers.cancel(job.jobId)
        }}
      />

      <ConnectionDialog
        open={showConnection}
        onClose={() => setShowConnection(false)}
        onSaved={() => void refreshConnections()}
      />

      <MirrorPreviewDialog
        preview={preview}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        onConfirm={() => void start(true)}
      />

      <Dialog open={showOptions} title="Transfer options" onClose={() => setShowOptions(false)}>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">General</div>
            <Checkbox
              checked={options.archive}
              onChange={(value) => setOptions({ ...options, archive: value })}
              label="Archive metadata"
              hint="Permissions, timestamps, symlinks, owner and group where permitted."
            />
            <Checkbox
              checked={options.checksum}
              onChange={(value) => setOptions({ ...options, checksum: value })}
              label="Verify by checksum"
              hint="Reads every candidate file on both ends. Much slower on large trees."
            />
            <Checkbox
              checked={options.compression === 'zstd'}
              onChange={(value) => setOptions({ ...options, compression: value ? 'zstd' : 'auto' })}
              label="Compress during transfer"
              hint="Worth it on a slow link, not on a fast one."
            />
          </div>
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Metadata</div>
            <Checkbox checked={options.hardLinks} onChange={(v) => setOptions({ ...options, hardLinks: v })} label="Preserve hard links" />
            <Checkbox checked={options.acls} onChange={(v) => setOptions({ ...options, acls: v })} label="Preserve ACLs" />
            <Checkbox checked={options.xattrs} onChange={(v) => setOptions({ ...options, xattrs: v })} label="Preserve extended attributes" />
          </div>
          <Banner kind="info">
            Partial-file resume is always on, and destination-only files are never deleted unless
            Mirror is enabled.
          </Banner>
        </div>
      </Dialog>
    </div>
  )
}

function refFor(pane: PaneState, path: string) {
  return pane.endpoint.kind === 'local'
    ? ({ type: 'local', path } as const)
    : ({ type: 'ssh', connectionId: pane.endpoint.connectionId, path } as const)
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
      }
    case 'change':
      return event.change.action === 'add' || event.change.action === 'update'
        ? { ...current, files: current.files + 1 }
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
