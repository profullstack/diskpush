import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What diskpush.com collects, and what the DiskPush application never sends anywhere.',
  alternates: { canonical: '/privacy' },
}

export default function PrivacyPage() {
  return (
    <div className="prose-docs mx-auto max-w-3xl px-5 py-12">
      <h1>Privacy</h1>

      <h2>The application</h2>
      <p>
        DiskPush is a local-first desktop application and CLI. It has no account system and no
        server component. It does not send your files, file names, paths, host names, connection
        names, or anything about a transfer to us or to anyone else.
      </p>
      <p>
        For a direct server-to-server transfer, the file payload moves between those two servers.
        It does not pass through your desktop, and there is no DiskPush infrastructure in the path.
        DiskPush will not silently fall back to relaying files; if a direct transfer is impossible
        it says so and stops.
      </p>
      <p>
        Connections, profiles and job history are stored in a local SQLite database under your own
        configuration directory. Passwords and key passphrases are never written to it.
      </p>
      <p>
        The application makes network connections only to the hosts you configure. It does not check
        for updates, report usage, or phone home.
      </p>

      <h2>This website</h2>
      <p>
        diskpush.com is a static and server-rendered site. It sets no tracking cookies and loads no
        advertising or cross-site tracking scripts.
      </p>
      <p>
        If analytics is ever enabled here it will be a privacy-respecting, aggregate-only tool, and
        it will never receive anything about your transfers, because this site is never told about
        them in the first place.
      </p>
      <p>
        The download page reads public release metadata from GitHub on the server, so your browser
        does not contact GitHub for it. Following a download link or a GitHub link is a request to
        GitHub, governed by their privacy policy.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="mailto:hello@profullstack.com">hello@profullstack.com</a>. Security
        reports: <a href="mailto:security@profullstack.com">security@profullstack.com</a>.
      </p>
    </div>
  )
}
