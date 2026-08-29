export const VERSION = '0.1.0'

export const HELP = `DiskPush ${VERSION} - push files fast, sync only what changed.

USAGE
  diskpush SOURCE DESTINATION [options] [-- rsync args]
  diskpush <command> [arguments] [options] [-- rsync args]

  The bare two-endpoint form is an alias for \`diskpush sync\`.
  Everything after a standalone \`--\` is passed to rsync verbatim.

ENDPOINTS
  ./dist/                 a local path
  prod:/srv/app/          a saved connection, or an ~/.ssh/config alias
  deploy@host:/var/www/   an explicit user and host

  Local -> Server, Server -> Local and Server A -> Server B are all supported.
  A server-to-server job runs rsync on the source host and moves the payload
  directly between the two servers; it is never relayed through this machine.

COMMANDS
  sync SRC DST            bring the destination up to date (default)
  push SRC DST            same engine, upload-shaped intent
  pull SRC DST            same engine, download-shaped intent
  publish SRC DST         same engine, deploy-shaped intent
  backup SRC DST          same engine, backup-shaped intent
  mirror SRC DST          sync AND delete destination-only files (previewed first)
  rsync SRC DST -- ARGS   endpoint resolution and orchestration only

  ls [ENDPOINT]           list a local or remote directory over SFTP
  connections             list saved connections
  connections add NAME [user@]host
  connections test NAME   check SSH, SFTP and remote rsync
  connections import [PATH]   import hosts from ~/.ssh/config
  connections remove NAME
  profiles                list saved sync profiles
  profiles save NAME SRC DST
  profiles show NAME
  profile run NAME        run a saved profile
  jobs                    recent transfer jobs
  job ID                  one job in detail
  retry ID                run a recorded job again (resumes from its partial file)

DEFAULTS
  Every transfer runs with archive metadata, resumable partial files,
  incremental skipping of unchanged files, and no destination deletes:

    rsync --archive --partial-dir=.rsync-partial --human-readable \\
          --itemize-changes --info=progress2 SOURCE DESTINATION

OPTIONS
  -n, --dry-run           preview the change set without transferring
      --print-args        show the exact rsync command and exit
      --preset NAME       fast-sync | exact-mirror | maximum-metadata |
                          slow-wan | verify-everything
  -p, --profile NAME      run with a saved profile's options
  -e, --exclude GLOB      exclude a pattern (repeatable)
      --exclude-preset N  node | git | macos | python | editor (repeatable)
      --include GLOB      include a pattern (repeatable, applied before excludes)
      --checksum          compare by checksum instead of size and time
      --compress[=ALGO]   zstd (default), zlib, or off
      --bwlimit RATE      e.g. 50M
      --max-size / --min-size SIZE
      --hard-links --acls --xattrs --numeric-ids --sparse
      --update --ignore-existing --existing
      --inplace --append-verify --mkpath
      --stats             include rsync's transfer statistics
  -y, --yes               confirm a mirror's deletions without prompting
      --non-interactive   never prompt; fail instead
      --json              machine-readable result on stdout
  -q, --quiet             suppress normal output
      --no-progress       do not draw a progress line
  -h, --help              this text
  -V, --version           print the version

EXIT CODES
  0                       success
  1-35                    rsync's own exit code, passed through
  64                      bad command line
  65                      unknown connection, profile or path
  66                      DiskPush declined (unconfirmed mirror, blocked argument)
  69                      precondition failed (rsync missing, host unreachable)
  70                      internal error

EXAMPLES
  diskpush ./dist/ production:/srv/app/
  diskpush pull production:/var/log/app/ ./logs/
  diskpush media-01:/srv/media/ backup-02:/data/media/
  diskpush mirror ./site/ prod:/var/www/site/ --exclude-preset node
  diskpush sync ./data/ prod:/data/ -- -aHAX --checksum
`
