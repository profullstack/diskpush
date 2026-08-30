export { VERSION } from './version.js'
import { VERSION } from './version.js'

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

  desktop                 launch the desktop app
  tui [SRC] [DST]         the two-pane browser, in this terminal

  fleet run "CMD"         run one command on every selected server
  fleet script FILE       run a local script file on every selected server
  fleet upgrade           install pending package updates, per host
  fleet check             what each server needs: updates, reboot, disk
  fleet servers           what --on can select, with tags
  fleet commands          saved commands and built-in recipes
  fleet runs / show ID    fleet history, and one run's full output

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

  doctor                  check rsync, ssh and the install
  update                  upgrade to the latest release  [alias: upgrade]
                          updates the CLI, and the desktop app when this
                          machine has a desktop  [--cli-only | --desktop]
  uninstall               remove DiskPush, keeping your connections and profiles
                          [alias: remove]

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
      --progress          rsync's own per-file progress instead of the
                          aggregate line DiskPush draws
      --stats             include rsync's transfer statistics
FLEET OPTIONS
      --on SELECTOR       which servers (repeatable, or comma-separated):
                            all              every server DiskPush knows
                            web-01           one, by name
                            web-*            a glob over names
                            tag:production   every server with that tag
                            host:10.0.0.*    a glob over hostnames
                            !web-03          remove one from the set
      --concurrency N     how many servers at once (default 4)
      --sudo              run through \`sudo -n\`, which fails rather than
                          hangs when a password is wanted
      --sudo-password     ask for a sudo password once, use it everywhere;
                          never written to disk
      --timeout SECONDS   per-server deadline (default 900, upgrade 3600)
      --stop-on-error     do not start further servers after one fails
      --accept-new        trust an unknown host key instead of failing
      --interpreter NAME  sh | bash | raw
      --cwd PATH          cd here on the server first
      --env KEY=VALUE     set an environment variable (repeatable)
      --print-command     print the script and exit
      --reboot[=always]   upgrade only: reboot hosts that need one, or all
      --no-sudo           upgrade only: you already connect as root
      --pending           check only: hide servers with nothing to do

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
  71                      a fleet run did not succeed on every server

EXAMPLES
  diskpush ./dist/ production:/srv/app/
  diskpush pull production:/var/log/app/ ./logs/
  diskpush media-01:/srv/media/ backup-02:/data/media/
  diskpush mirror ./site/ prod:/var/www/site/ --exclude-preset node
  diskpush sync ./data/ prod:/data/ -- -aHAX --checksum

  diskpush fleet check --on tag:production
  diskpush fleet upgrade --on tag:production --sudo --concurrency 2
  diskpush fleet run "systemctl reload nginx" --on web-* --sudo
  diskpush fleet script ./rotate-keys.sh --on all '!db-01'
`
