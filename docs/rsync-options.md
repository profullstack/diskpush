# rsync options

Three levels of access:

```text
1. Safe defaults       Always on. Nothing to configure.
2. Structured options  GUI controls and DiskPush CLI flags.
3. Raw rsync args       Everything after `--`.
```

## The table

| Capability | rsync flag | Default | DiskPush |
| --- | --- | --- | --- |
| Archive | `--archive` | On | Archive metadata |
| Recursive (archive off) | `--recursive` | On | implied |
| Partial directory | `--partial-dir=DIR` | `.rsync-partial` | Resume interrupted transfers |
| Partial files | `--partial` | used when no partial dir | Resume interrupted transfers |
| Human-readable | `--human-readable` | On | Human-readable sizes |
| Itemized changes | `--itemize-changes` | On | Change details |
| Itemize everything | `--itemize-changes` twice | Off | Show unchanged rows |
| Overall progress | `--info=progress2` | On | Progress |
| Statistics | `--stats` | Off | `--stats` |
| Compression | `--compress` | Off | `--compress` |
| Compression algorithm | `--compress-choice=zstd` | — | `--compress=zstd` |
| Hard links | `--hard-links` | Off | `--hard-links` |
| ACLs | `--acls` | Off | `--acls` |
| Extended attributes | `--xattrs` | Off | `--xattrs` |
| Numeric IDs | `--numeric-ids` | Off | `--numeric-ids` |
| Sparse files | `--sparse` | Off | `--sparse` |
| Checksum comparison | `--checksum` | Off | `--checksum` |
| Update only | `--update` | Off | `--update` |
| Ignore existing | `--ignore-existing` | Off | `--ignore-existing` |
| Existing only | `--existing` | Off | `--existing` |
| Delete | `--delete-delay` | Off | Mirror |
| Exclude | `--exclude=PATTERN` | none | `--exclude` |
| Exclude file | `--exclude-from=FILE` | none | `--exclude-from` |
| Include | `--include=PATTERN` | none | `--include` |
| Include file | `--include-from=FILE` | none | `--include-from` |
| Files from | `--files-from=FILE` | none | `--files-from` |
| Bandwidth limit | `--bwlimit=RATE` | unlimited | `--bwlimit` |
| Max / min size | `--max-size` `--min-size` | none | `--max-size` `--min-size` |
| Prune empty dirs | `--prune-empty-dirs` | Off | `--prune-empty-dirs` |
| Relative paths | `--relative` | Off | `--relative` |
| Dry run | `--dry-run` | auto for mirror | `--dry-run` |
| In-place | `--inplace` | Off | `--inplace` |
| Append and verify | `--append-verify` | Off | `--append-verify` |
| Whole file | `--whole-file` / `--no-whole-file` | auto | whole-file mode |
| Create destination path | `--mkpath` | Off | `--mkpath` |
| Remote rsync path | `--rsync-path=PROGRAM` | auto | connection setting |
| SSH transport | `--rsh` | managed | connection setting |
| Timeout | `--timeout=SECONDS` | none | `--timeout` |
| Shield remote args | `--protect-args` | version-gated | automatic |

## Ordering

The builder emits flags in a fixed order, and two parts of that order matter:

**Includes before excludes.** rsync applies filter rules in order and takes the
first match, so an include listed after a broad exclude would never be reached.

**Pass-through last.** Raw tokens are appended after the generated flags, so
for the many options where rsync takes the last occurrence, yours wins.

## Version gating

Not every flag exists everywhere, and a flag one end does not understand fails
the run. DiskPush parses `rsync --version` on both ends and intersects them.

| Option | Requires |
| --- | --- |
| `--compress-choice=zstd` | 3.2.0+, and a build that included zstd |
| `--mkpath` | 3.2.3+ |
| `--protect-args` | 3.0.0+ |
| `--secluded-args` by default | 3.2.4+ |
| `--acls`, `--xattrs` | a build with support, on both ends |

The remote side is only known once `diskpush connections test` has run; its
report is cached against the connection. Without it, DiskPush uses the local
view, which errs toward adding safety flags rather than omitting them.

When an option is dropped, you are told:

```text
warning: zstd compression was downgraded to zlib: at least one end of this
transfer was not built with zstd.
```

## Notes on individual options

### `--checksum`

Compares content hashes instead of size and modification time. Correct in more
cases; much slower, because every candidate file is read on both ends.

### `--inplace`

Writes directly into the destination file rather than to a temporary. Useful
for very large files and copy-on-write filesystems. It changes failure
semantics: an interrupted transfer leaves the destination partially
overwritten, so it is not compatible with the resume story the defaults give
you. Advanced only, and warned about.

### `--append-verify`

Assumes the existing destination file is a valid prefix of the source and
appends, then verifies. Right for resuming a known-truncated large file. Wrong
if the destination file is a *different* file of the same name. Never on by
default.

### `--delete-delay`

The delete mode Mirror uses. Deletions are computed during the transfer and
performed at the end, rather than up front, so a failure part way through has
not already removed things.

## Mirror mode

Mirror is the only mode that deletes, and it is the only one that cannot run
unexamined:

1. A dry run with `--itemize-changes` produces the change set.
2. The proposed deletions are listed.
3. Only after confirmation can the live job even be constructed.

This is enforced in `buildRsyncArgs`, not in the interface, so the CLI, the
desktop app, and anything built on `rsync-core` later all get it.

## Presets

| Preset | What it changes |
| --- | --- |
| `fast-sync` | The defaults. |
| `exact-mirror` | Adds `--delete-delay`. Always previews. |
| `maximum-metadata` | Adds hard links, ACLs, xattrs. |
| `slow-wan` | Adds zstd compression. |
| `verify-everything` | Adds `--checksum`. |

## Exclude presets

| Name | Patterns |
| --- | --- |
| `node` | `node_modules/`, `.next/`, `dist/`, `.turbo/`, `*.log` |
| `git` | `.git/`, `.gitignore` |
| `macos` | `.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes` |
| `python` | `__pycache__/`, `*.pyc`, `.venv/`, `venv/` |
| `editor` | `.idea/`, `.vscode/`, `*.swp`, `*~` |

## Pass-through

See [cli.md](cli.md#pass-through) for what is passed verbatim and the two
families that are refused.
