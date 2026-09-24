# Plugins

A plugin adds things DiskPush does to files: a command in the CLI, an entry
in the TUI's `a` menu and in the desktop app's right-click menu, and settings
of its own. The first one is **MediaAnalyzer**, which describes photos and
videos and can sort them into folders by what they show.

```bash
diskpush plugins                                # what is installed, and its commands
diskpush plugins disable mediaanalyzer          # and back on with: enable
diskpush mediaanalyzer login                    # a plugin's own commands
diskpush mediaanalyzer analyze ~/Pictures/2024 --sort
```

| Surface | Where plugin actions are |
| --- | --- |
| CLI | `diskpush <plugin-id> <command> ...` |
| TUI | `a` on a local file or folder, then enter, the action's letter, or one click |
| Desktop | right-click a local selection → **Plugins**; settings and sign-in under the header menu → **Plugins…** |

Actions work on local files only. A pane pointed at a server has nothing on
this machine to hand a plugin; sync the files down first.

## MediaAnalyzer

[MediaAnalyzer](https://mediaanalyzer.pro) looks at each photo (and, with
ffmpeg installed, each video) and returns a description, tags and a category.
DiskPush writes those beside the file and can file it into a folder named for
the category.

```bash
diskpush mediaanalyzer login          # opens your browser; approve DiskPush
diskpush mediaanalyzer whoami         # who, how much credit, which tiers are online
diskpush mediaanalyzer analyze DIR    # describe everything under DIR
diskpush mediaanalyzer analyze DIR --sort
diskpush mediaanalyzer undo DIR       # put back what the last --sort moved
diskpush mediaanalyzer logout
```

**What it writes.** For `beach.jpg`, a `beach.jpg.description.txt`:

```text
Two children building a sandcastle at low tide.

Folder: Beach
Tags: beach, children, sandcastle
Described by MediaAnalyzer (mediaanalyzer.pro)
```

The last line is the signature. A `.description.txt` without it is yours, and
is never overwritten; one with it is, because DiskPush wrote it.

**Sorting.** *Analyze and sort into folders* (`--sort`) moves each file and
its description into `DIR/<Category>/`. Nothing is ever overwritten: a name
that is taken becomes `beach (2).jpg`. Every move is written to a journal in
`DIR/.mediaanalyzer/undo-<time>.json` before it happens, and *Undo last sort*
(`undo DIR`) walks the latest journal backwards, restoring the exact tree. A
file you have since replaced is skipped, not overwritten.

**Paying once.** Each file is identified by a hash of its relative path, size
and modification time. `DIR/.mediaanalyzer/diskpush-state.json` records the
scan and every result as it arrives, so a run that is cancelled, crashes or
loses its connection picks up where it stopped: nothing is uploaded or charged
twice. A file with a signed sidecar is treated as already described, whichever
tool wrote it.

**What is uploaded.** Photos are sent as they are, up to 30 MB each; the
server re-encodes them to 768 px and strips their metadata (EXIF, GPS) before
anything else sees them. A video is never uploaded: DiskPush sends one JPEG
contact sheet of nine frames, made locally with `ffmpeg`. Without `ffmpeg` and
`ffprobe` on `PATH`, videos are skipped and the run says so. Uploads go in
requests of at most 50 files.

**Settings** (`Plugins…` in the desktop app, or the shared settings table):

| Setting | Meaning |
| --- | --- |
| `server` | `https://mediaanalyzer.pro` unless you run your own |
| `tier` | `standard`, `premium` or `byok`. Empty: the first tier that is online, else your own provider key |
| `providerId` | which provider key `byok` uses; empty is your first |
| `folders` | comma-separated categories to sort into; empty uses the server's |
| `api_key` | an `ma_key_…` key instead of signing in (`diskpush mediaanalyzer key`) |

`DISKPUSH_MEDIAANALYZER_KEY` in the environment overrides both a sign-in and a
saved key, which is the way to run it from CI.

**Signing in.** OAuth 2.1 with PKCE, as the `diskpush` client, over a loopback
redirect to `127.0.0.1` on a random port. No password is ever typed into
DiskPush. Refresh tokens rotate: each works once, so DiskPush stores the new
one the moment it arrives and never refreshes twice at once. With no browser
on this machine (an ssh session), `login --paste` shows a URL to open anywhere
and asks for the code the page displays.

**Credit.** When the account runs out mid-run, what was accepted is still
described, the rest is left for the next run, and the result says how many
were skipped and where to add credit.

## Writing a plugin

A plugin is an object. `definePlugin` checks its shape when it is defined, so
a bad id fails your tests rather than someone's menu.

```ts
import { definePlugin } from '@diskpush/plugin-api'

export default definePlugin({
  id: 'checksums',                 // also the CLI command: diskpush checksums ...
  name: 'Checksums',
  version: '1.0.0',
  description: 'Write a SHA-256 beside each file.',
  actions: [
    {
      id: 'sha256',
      label: 'Write SHA-256 sums',
      tuiKey: 's',                 // a hint; dropped if it clashes
      appliesTo: (entries) => entries.some((entry) => !entry.isDirectory),
      async run(ctx) {
        ctx.progress.start(ctx.entries.length)
        let done = 0
        for (const entry of ctx.entries) {
          ctx.signal.throwIfAborted()
          // ... hash join(ctx.dir, entry.name) ...
          ctx.progress.update({ done: ++done, currentFile: entry.name })
        }
        return { ok: true, message: `Wrote ${done} sums.`, changed: true }
      },
    },
  ],
  commands: [
    {
      name: 'verify',
      summary: 'check every sum under DIR',
      usage: 'verify DIR',
      async run(args, ctx) {
        ctx.print(`verifying ${args[0]}`)
        return 0                   // the exit code
      },
    },
  ],
  settings: [{ key: 'algorithm', label: 'Algorithm', type: 'enum', options: ['sha256', 'sha512'], default: 'sha256' }],
})
```

### The context

Every action, command and task gets one context object, whichever surface runs
it (`ctx.surface` says which: `cli`, `tui` or `desktop`).

| Member | What it is |
| --- | --- |
| `dir`, `names`, `entries` | actions only: the absolute local directory, and the selected entries in it as bare names (never paths), each with `isDirectory` and `size` |
| `settings.get(key, fallback)` / `settings.set(key, value)` | your settings, stored as `plugin:<id>:<key>` in the table the CLI and the desktop share |
| `secrets.get(key)` / `secrets.set(key, value \| null)` | tokens and keys, stored apart from settings and never sent to the desktop renderer |
| `progress.start(total?)`, `progress.update({done, total, message, currentFile})`, `progress.log(level, message)` | the CLI's status line, the TUI's job panel, the desktop's transfer band |
| `openUrl(url)` | the user's browser; http and https only |
| `signal` | aborted on Ctrl+C, esc, or Cancel. Stop, save what you have, return |
| `env` | environment variables |
| `print`, `warn`, `printJson`, `json`, `prompt`, `cwd` | commands only |

An action returns `{ ok, message, changed? }`. `changed: true` makes the file
browser read the directory again. A thrown error becomes a failed result with
its message; it never takes the host down.

`appliesTo(entries, { dir })` runs as a menu opens, so it must be cheap and
synchronous. `tasks` are actions that take no files (signing in); the desktop
draws them as buttons in the plugin's settings.

### Installing one

```bash
diskpush plugins add some-diskpush-plugin     # from npm
diskpush plugins remove <plugin-id>
```

External plugins live in their own small npm project,
`~/.config/diskpush/plugins/` (or `$DISKPUSH_HOME/plugins/`). A package is
loaded only if it is listed in that directory's `package.json` and its own
`package.json` has a `"diskpush"` field, e.g. `"diskpush": { "apiVersion": 1 }`.
Its default export (or `export const plugin`) is the plugin. `add` needs `npm`
on `PATH`, and installs with `--ignore-scripts`. The desktop app loads the same
directory at start.

A plugin written against another major version of the API
(`PLUGIN_API_VERSION`, currently 1) is refused with a message rather than
loaded and left to fail.

## Security model

**A plugin runs with your privileges.** It is JavaScript in the CLI process,
or in the desktop app's *main* process, and it can do anything you can: read
and change any file, open network connections, run programs. Nothing sandboxes
it. Adding a plugin is the same decision as installing a program, and
`diskpush plugins add` says so before it installs anything.

What DiskPush does guarantee:

- **Never in the renderer.** The desktop renderer is treated as untrusted
  input everywhere, and plugins do not change that. It names a plugin and an
  action by id and the files as an absolute local directory plus bare entry
  names (the same `EntryNameSchema` every file operation uses), all validated
  by Zod in the main process. It cannot hand a plugin `../`, a path of its own,
  or a server path, and there is still no generic `invoke`: the preload exposes
  named plugin methods only.
- **Secrets stay out of the renderer.** A plugin's secret settings can be set
  from the desktop's settings dialog but are never sent back to it; the dialog
  only learns whether one is set.
- **Symlinks are not followed** when a selection is described or walked, so an
  action on a folder cannot be led outside it.
- **Only declared settings** can be written from the desktop, each checked
  against its declared type.
- **Loading is explicit.** Only packages listed in the plugins `package.json`
  and marked as DiskPush plugins load; one that fails is reported and skipped.
- **The store is owner-only.** Sign-ins are kept in the local database's
  settings table, and DiskPush sets that file to mode `0600` when it opens it.
  They are not yet in the OS keychain; see below.

Built-in plugins ship inside DiskPush and are reviewed with it.

### Not yet

- Secrets in the OS keychain (Electron `safeStorage`, `libsecret`). The hook is
  there (`SecretCodec` in `@diskpush/plugin-api`), but encrypting with the
  desktop's keychain would lock the CLI out of the same sign-in, so it waits
  for a keychain both can reach.
- Plugin actions on remote panes.
- Adding plugins from the desktop app (it has no `npm`).
