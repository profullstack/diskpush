'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { CircleCheck, Settings, Users } from 'lucide-react'
import { ConnectionDialog } from '@/components/connection-dialog'
import { endpointLabel, loadPane, Pane, type PaneEndpoint, type PaneState } from '@/components/pane'
import { TransferRail } from '@/components/transfer-rail'
import { MirrorPreviewDialog, TransferBand, type ActiveJob } from '@/components/transfer-panel'
import { Button } from '@/components/ui/button'
import { api, unwrap, type Connection, type PreviewResult, type TransferEvent } from '@/lib/api'
import { withTrailingSlash } from '@/lib/format'

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
        <p className="max-w-md rounded-lg border border-line bg-card p-4 text-[13px] text-muted-foreground">
          This is the DiskPush renderer. It runs inside the desktop shell, which provides the filesystem and transfer
          bridge.
        </p>
      </div>
    )
  }

  const connected = saved.length + sshConfig.length

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-line bg-chrome px-4">
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
          className="hidden h-[22px] w-auto dark:block"
          priority
        />
        <Image
          src="/logo.png"
          alt="DiskPush"
          width={2172}
          height={724}
          className="block h-[22px] w-auto dark:hidden"
          priority
        />
        <div className="h-5 w-px bg-line" />
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <CircleCheck className="size-3.5 text-ok" />
          <span className="text-foreground">{connected}</span>
          <span>server{connected === 1 ? '' : 's'} available</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowConnection(true)} className="h-[30px] gap-2 border-line-strong text-[12px]">
            <Users className="size-3.5" />
            New server
          </Button>
          <Button variant="outline" className="h-[30px] w-[30px] border-line-strong p-0 text-muted-foreground">
            <Settings className="size-[15px]" />
          </Button>
        </div>
      </header>

      {error ? (
        <div className="selectable border-b border-[#45202e] bg-[#1c1119] px-4 py-2 text-[12px] text-[#fca5a5]">{error}</div>
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
        onCancel={() => {
          if (job) void api()?.transfers.cancel(job.jobId)
        }}
      />

      <footer className="flex h-[26px] shrink-0 items-center gap-3.5 border-t border-line bg-background px-4 text-[11px] text-faint">
        <span>Incremental sync</span>
        <span>Archive metadata on</span>
        <span>Resume on</span>
        <span className={mirror ? 'text-destructive' : 'text-ok'}>Deletes {mirror ? 'ON' : 'off'}</span>
        <span className="selectable ml-auto font-[family-name:var(--font-mono)]">
          rsync --archive --partial-dir=.rsync-partial --info=progress2
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
