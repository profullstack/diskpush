import Link from 'next/link'
import { Code } from '@/components/chrome'
import { SITE } from '@/lib/site'

const FAQ = [
  {
    q: 'What is DiskPush?',
    a: 'A desktop app and CLI that browses servers like an SFTP client and transfers with rsync, so unchanged files are skipped, interrupted transfers resume, and metadata survives.',
  },
  {
    q: 'Does DiskPush use rsync?',
    a: 'Yes, for every transfer. DiskPush builds the arguments and reads the output; rsync moves the bytes. `diskpush --print-args` shows the exact command.',
  },
  {
    q: 'Does DiskPush use SFTP?',
    a: 'For browsing. rsync can list files, but it cannot rename, chmod or delete, so the interactive file browser is SFTP over the same SSH connection.',
  },
  {
    q: 'Does DiskPush upload my files to a cloud service?',
    a: 'No. There is no DiskPush server in any transfer path, and no account is needed for anything.',
  },
  {
    q: 'Can DiskPush copy directly between two servers?',
    a: 'Yes. DiskPush does not act as a file relay for direct server-to-server transfers. The file payload moves directly between the two configured servers; rsync runs on the source host and connects straight to the destination.',
  },
  {
    q: 'Does DiskPush retransmit unchanged files?',
    a: 'No. rsync compares size and modification time, and skips anything that matches. Re-running a finished job moves almost nothing.',
  },
  {
    q: 'Can interrupted transfers resume?',
    a: 'Yes. Partial data is kept in a partial directory beside the destination, so a retry continues instead of starting over, and a half-received file is never mistaken for a finished one.',
  },
  {
    q: 'Does DiskPush delete destination files?',
    a: 'Only in Mirror mode, which you enable explicitly, and only after showing you the exact list of files it would delete.',
  },
  {
    q: 'Can I use normal rsync flags?',
    a: 'Everything after a standalone -- is passed to rsync verbatim. DiskPush refuses only the delete family, which would bypass the preview that exists to show you those deletions.',
  },
  {
    q: 'Does DiskPush work without the desktop app?',
    a: 'Yes. The CLI is a first-class surface sharing the same engine, connections and profiles.',
  },
]

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'SoftwareApplication',
                name: 'DiskPush',
                applicationCategory: 'DeveloperApplication',
                operatingSystem: 'Linux, macOS',
                description: SITE.description,
                url: SITE.url,
                offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
              },
              {
                '@type': 'FAQPage',
                mainEntity: FAQ.map((item) => ({
                  '@type': 'Question',
                  name: item.q,
                  acceptedAnswer: { '@type': 'Answer', text: item.a },
                })),
              },
            ],
          }),
        }}
      />

      <Hero />
      <HowItWorks />
      <Features />
      <Desktop />
      <Defaults />
      <Cli />
      <OpenSource />
      <Faq />
    </>
  )
}

function Hero() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto grid max-w-6xl min-w-0 gap-10 px-5 py-20 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:py-28">
        <div>
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
            Push files fast.
            <br />
            <span className="text-accent">Sync only what changed.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            DiskPush is a desktop app and CLI for rsync. Browse servers like FileZilla. Copy, sync,
            archive, backup or publish with resumable incremental transfers. Move files directly
            between two servers without routing the payload through DiskPush.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/download"
              className="rounded-md bg-accent-strong px-5 py-2.5 font-medium text-white transition-opacity hover:opacity-90"
            >
              Download DiskPush
            </Link>
            <a
              href={SITE.repo}
              rel="noreferrer"
              target="_blank"
              className="rounded-md border border-line px-5 py-2.5 font-medium transition-colors hover:bg-surface"
            >
              View on GitHub
            </a>
          </div>
          <p className="mt-4 text-sm text-muted">
            Linux first. macOS supported. Open source, MIT licensed.
          </p>
        </div>

        <div className="min-w-0 space-y-3">
          <Code label="install — desktop app and CLI">{`curl -fsSL https://diskpush.com/install.sh | sh`}</Code>
          <Code label="local → server">{`diskpush ./dist/ production:/srv/app/`}</Code>
          <Code label="server → server, directly">{`diskpush media:/srv/media/ backup:/data/media/`}</Code>
        </div>
      </div>
    </section>
  )
}

function HowItWorks() {
  return (
    <section className="border-b border-line bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <p className="mt-2 max-w-2xl text-muted">
          DiskPush controls the transfer. Your files move directly between the endpoints.
        </p>
        <div className="mt-8 grid min-w-0 gap-4 lg:grid-cols-2">
          <Code label="browsing" copyable={false}>{`DiskPush Desktop ──SFTP/SSH──> Server 1
        │
        └──────────SFTP/SSH──> Server 2`}</Code>
          <Code label="transfer" copyable={false}>{`Server 1 ═══════ rsync/SSH ═══════> Server 2

Desktop relay:  none
DiskPush relay: none`}</Code>
        </div>
      </div>
    </section>
  )
}

const FEATURES = [
  {
    title: 'FileZilla-style browser',
    body: 'Local or Server 1 on the left, Remote or Server 2 on the right. Browse remote files over SFTP, with rename, chmod, mkdir and delete.',
  },
  {
    title: 'rsync underneath',
    body: 'Skip unchanged files. Preserve archive metadata. Resume partial transfers. The engine is rsync, not an imitation of it.',
  },
  {
    title: 'Server → Server',
    body: 'Transfer directly between two remote machines. Your desktop and DiskPush never relay the file payload, and never silently start.',
  },
  {
    title: 'Safe by default',
    body: 'Archive, partial resume and incremental sync are on. Destination-only files are never deleted unless you explicitly enable Mirror.',
  },
  {
    title: 'CLI included',
    body: 'The same engine, connections and profiles, with no GUI required. Structured JSON output and stable exit codes for scripts.',
  },
  {
    title: 'Full rsync control',
    body: 'Everything after -- goes to rsync verbatim. No re-parsing, no shell, no surprises.',
  },
]

function Features() {
  return (
    <section id="features" className="border-b border-line">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Built for moving real trees</h2>
        <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="bg-ink p-6">
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Desktop() {
  return (
    <section className="border-b border-line bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid min-w-0 gap-10 lg:grid-cols-[1fr_1.15fr] lg:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Browse before you sync</h2>
            <p className="mt-4 leading-relaxed text-muted">
              Use SFTP to inspect the target server, then let rsync move only what changed. Before a
              destructive mirror, DiskPush shows the exact files that would be deleted, and the
              destination pane stays browsable while you decide.
            </p>
            <Link href="/docs/desktop" className="mt-6 inline-block text-accent hover:underline">
              How the desktop app works →
            </Link>
          </div>
          <Code label="two-pane workspace" copyable={false}>{`┌──────────────────────────┬──────────────────────────┐
│ LEFT: Local / Server 1   │ RIGHT: Remote / Server 2 │
│ [ Local ▼ ]              │ [ production ▼ ]         │
│ /home/anthony/projects   │ /var/www                 │
│                          │                          │
│ 📁 app                   │ 📁 app                   │
│ 📁 media                 │ 📁 releases              │
│ 📄 package.json          │ 📄 current.env           │
├──────────────────────────┴──────────────────────────┤
│ [Preview Changes] [Sync →] [← Sync] [Mirror…]       │
├─────────────────────────────────────────────────────┤
│ ↑ app/  4,281 files  1.2/8.7 GB  112 MB/s  14%      │
└─────────────────────────────────────────────────────┘`}</Code>
        </div>
      </div>
    </section>
  )
}

function Defaults() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">
          The rsync flags you normally want are already on.
        </h2>
        <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <Code label="what you type">{`diskpush ./data/ server:/data/`}</Code>
            <Code label="what runs">{`rsync \\
  --archive \\
  --partial-dir=.rsync-partial \\
  --human-readable \\
  --itemize-changes \\
  --info=progress2 \\
  ./data/ server:/data/`}</Code>
          </div>
          <ul className="space-y-3 text-muted">
            {[
              'Unchanged files are skipped.',
              'Interrupted transfers can resume.',
              'Destination-only files are preserved.',
              'Permissions, timestamps and symlinks survive.',
              'Nothing is deleted unless you ask for Mirror.',
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-1 text-accent" aria-hidden="true">✓</span>
                <span>{item}</span>
              </li>
            ))}
            <li className="pt-2">
              <Link href="/docs/defaults" className="text-accent hover:underline">
                Read the reasoning behind each default →
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}

function Cli() {
  return (
    <section className="border-b border-line bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Same engine. No GUI required.</h2>
        <div className="mt-8 min-w-0">
          <Code>{`# local → server
diskpush ./dist/ prod:/srv/app/

# server → local
diskpush prod:/var/log/app/ ./logs/

# direct server → server
diskpush media:/srv/media/ backup:/data/media/

# native rsync options
diskpush ./data/ prod:/data/ -- -aHAX --checksum`}</Code>
        </div>
        <Link href="/docs/cli" className="mt-6 inline-block text-accent hover:underline">
          CLI documentation →
        </Link>
      </div>
    </section>
  )
}

function OpenSource() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Open source, and auditable on purpose</h2>
        <p className="mt-4 max-w-3xl leading-relaxed text-muted">
          A tool that runs a copy command with your credentials, sometimes with a delete flag,
          should be one you can read. rsync is spawned with an argument array and no shell. Remote
          arguments are shielded from the remote login shell. A mirror cannot be constructed as a
          live job until its delete list has been confirmed.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href={SITE.repo}
            rel="noreferrer"
            target="_blank"
            className="rounded-md border border-line px-4 py-2 text-sm font-medium transition-colors hover:bg-surface"
          >
            Read the source
          </a>
          <Link
            href="/docs/security"
            className="rounded-md border border-line px-4 py-2 text-sm font-medium transition-colors hover:bg-surface"
          >
            Security model
          </Link>
        </div>
      </div>
    </section>
  )
}

function Faq() {
  return (
    <section id="faq">
      <div className="mx-auto max-w-3xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
        <dl className="mt-8 divide-y divide-line border-y border-line">
          {FAQ.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="font-medium">{item.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
