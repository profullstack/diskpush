import { defaultRsyncOptions, type PresetName, type RsyncOptions } from '@diskpush/schemas'

export type PresetDefinition = {
  name: PresetName
  label: string
  description: string
  warning?: string
  options: RsyncOptions
}

/**
 * The DiskPush baseline. Everything else is this, adjusted.
 *
 * Equivalent to:
 *   rsync --archive --partial --partial-dir=.rsync-partial \
 *         --human-readable --itemize-changes --info=progress2 SRC DST
 */
export function fastSyncOptions(): RsyncOptions {
  return defaultRsyncOptions()
}

export const PRESETS: Record<PresetName, PresetDefinition> = {
  'fast-sync': {
    name: 'fast-sync',
    label: 'Fast Sync',
    description: 'Recursive, archive metadata, resumable, skips unchanged files, never deletes.',
    options: fastSyncOptions(),
  },
  'exact-mirror': {
    name: 'exact-mirror',
    label: 'Exact Mirror',
    description: 'Makes the destination match the source, deleting destination-only files.',
    warning: 'Deletes files at the destination. Always previewed before it runs.',
    options: defaultRsyncOptions({ deleteMode: 'delay' }),
  },
  'maximum-metadata': {
    name: 'maximum-metadata',
    label: 'Maximum Metadata',
    description: 'Archive plus hard links, ACLs and extended attributes.',
    warning: 'Scanning is slower, and both ends must support the requested attributes.',
    options: defaultRsyncOptions({ hardLinks: true, acls: true, xattrs: true }),
  },
  'slow-wan': {
    name: 'slow-wan',
    label: 'Slow WAN',
    description: 'Adds compression for links where CPU is cheaper than bandwidth.',
    options: defaultRsyncOptions({ compression: 'zstd' }),
  },
  'verify-everything': {
    name: 'verify-everything',
    label: 'Verify Everything',
    description: 'Compares every file by checksum instead of size and timestamp.',
    warning: 'Reads every candidate file on both ends. Much slower on large trees.',
    options: defaultRsyncOptions({ checksum: true }),
  },
}

/** Common exclusion sets offered in the UI and by `--exclude-preset`. */
export const EXCLUDE_PRESETS: Record<string, string[]> = {
  node: ['node_modules/', '.next/', 'dist/', '.turbo/', '*.log'],
  git: ['.git/', '.gitignore'],
  macos: ['.DS_Store', '._*', '.Spotlight-V100', '.Trashes'],
  python: ['__pycache__/', '*.pyc', '.venv/', 'venv/'],
  editor: ['.idea/', '.vscode/', '*.swp', '*~'],
}

export function presetOptions(name: PresetName, overrides: Partial<RsyncOptions> = {}): RsyncOptions {
  return { ...PRESETS[name].options, ...overrides }
}
