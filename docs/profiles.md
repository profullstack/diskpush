# Sync profiles

A profile is a repeatable Source → Destination job with its options attached.

```bash
diskpush profiles save website ./site/ prod:/var/www/site/ \
  --exclude-preset node \
  --exclude-preset git \
  --exclude '.next/cache/'

diskpush profile run website
```

## What a profile holds

```text
name
source, destination     structured endpoints, not strings
preset
options                 the full typed option set
trustDeletes            unattended mirroring; off by default
schedule                off by default
watch                   off by default
notifyOnSuccess / notifyOnFailure
```

Profiles and connections live in one local database shared with the desktop
app. A profile created in the CLI appears in the app, and the reverse. There is
deliberately no second configuration universe.

## Direction

rsync is directional, and so is a profile: it is a Source → Destination job.
Reversing it is an explicit action that produces a different job, not a mode.

DiskPush does not offer two-way sync. Running a job in both directions is not
bidirectional synchronisation, it is a way to lose edits: with no record of
prior state there is no way to tell a deletion from a file that has not
arrived yet. Real bidirectional sync needs per-file fingerprints, tombstones,
rename detection and a conflict UI. Until that exists, every job shows its
direction.

## Mirror profiles

A profile can carry `deleteMode`, which makes it a mirror. It still previews
and still asks, on every run, unless `trustDeletes` is turned on for that
specific profile.

`trustDeletes` cannot be set from the command line at save time. Unattended
deletion is a decision that should be made once, deliberately, on a profile
that already exists and whose behaviour you have watched.

## Scheduling and watching

Both are profile settings, both off by default.

- **Schedule:** every 5 or 15 minutes, hourly, daily, or a cron expression.
  Scheduling happens locally; a scheduled server-to-server job still runs from
  Server A to Server B.
- **Watch:** filesystem events on a local source trigger a debounced run. The
  debounce matters: one rsync per file event would be far slower than one rsync
  for the batch.
