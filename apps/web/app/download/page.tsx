import type { Metadata } from 'next'
import { Code } from '@/components/chrome'
import { SITE } from '@/lib/site'
import { latestRelease } from '@/lib/releases'

export const metadata: Metadata = {
  title: 'Download',
  description: 'Download DiskPush for Linux and macOS, or install the CLI. AppImage, .deb, and build-from-source instructions.',
  alternates: { canonical: '/download' },
}

// Release metadata is fetched server-side and revalidated hourly rather than
// embedded in the client or stored in a database.
export const revalidate = 3600

export default async function DownloadPage() {
  const release = await latestRelease()

  return (
    <div className="mx-auto max-w-4xl px-5 py-16">
      <h1 className="text-3xl font-bold tracking-tight">Download DiskPush</h1>
      <p className="mt-3 text-muted">
        {release
          ? `Current stable version ${release.version}, released ${new Date(release.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
          : 'Builds are published to GitHub Releases. Until the first tagged release, install from source.'}
      </p>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Requirements</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          DiskPush drives rsync and SSH rather than reimplementing them, so both need to exist on
          this machine, and rsync needs to exist on any server you transfer to or from.
        </p>
        <div className="mt-4">
          <Code label="debian / ubuntu">{`sudo apt install rsync openssh-client`}</Code>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Desktop</h2>
        <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
          <Asset name="Linux AppImage" note="x86_64, no install required" href={release?.assets.linuxAppImage ?? null} />
          <Asset name="Debian / Ubuntu (.deb)" note="amd64" href={release?.assets.linuxDeb ?? null} />
          <Asset name="macOS (.dmg)" note="Apple silicon and Intel" href={release?.assets.macDmg ?? null} />
          <Asset name="Windows" note="Planned; needs WSL2 rsync" href={release?.assets.windowsExe ?? null} />
        </div>
        <p className="mt-3 text-xs text-muted">
          Linux is the reference platform. Checksums are published alongside each release.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">CLI</h2>
        <p className="mt-2 text-sm text-muted">
          The CLI is a first-class surface, sharing the same engine, connections and profiles as the
          desktop app.
        </p>
        <div className="mt-4 space-y-3">
          <Code label="from source">{`git clone ${SITE.repo}
cd diskpush
pnpm install
pnpm build
node apps/cli/dist/bin.js --help`}</Code>
        </div>
        <p className="mt-3 text-xs text-muted">
          A shell installer will be offered once binaries are published. It will be short enough to
          read, will verify checksums, and manual instructions will always be documented alongside
          it, because nobody should have to pipe an unread script into a shell.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">All releases</h2>
        <p className="mt-2 text-sm">
          <a className="text-accent hover:underline" href={SITE.releases} rel="noreferrer" target="_blank">
            GitHub Releases →
          </a>
        </p>
      </section>
    </div>
  )
}

function Asset({ name, note, href }: { name: string; note: string; href: string | null }) {
  if (!href) {
    return (
      <div className="bg-ink p-5">
        <div className="font-medium text-muted">{name}</div>
        <div className="mt-1 text-sm text-muted">{note}</div>
        <div className="mt-3 text-xs uppercase tracking-wider text-muted">Not yet published</div>
      </div>
    )
  }
  return (
    <a className="block bg-ink p-5 transition-colors hover:bg-surface" href={href} rel="noreferrer">
      <div className="font-medium">{name}</div>
      <div className="mt-1 text-sm text-muted">{note}</div>
      <div className="mt-3 text-xs font-medium uppercase tracking-wider text-accent">Download →</div>
    </a>
  )
}
