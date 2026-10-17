import type { Connection } from '@/lib/api'

/**
 * The S3 half of the connection forms: provider presets, the draft the form
 * edits, and the payload it sends. Shared by the quick New-server dialog and
 * the full server manager so the two cannot drift.
 *
 * The secret access key is write-only. The form starts it empty, `hasSecret`
 * says whether one is already stored, and the payload carries it only when the
 * user typed one (or asked to clear it).
 */

export type S3Provider = 'aws' | 'r2' | 'b2' | 'other'

export type PathStyleChoice = 'auto' | 'on' | 'off'

type Preset = {
  label: string
  /** Pre-filled into the endpoint field; `<…>` parts are for the user to replace. */
  endpoint: string
  region: string
  /** Shown under the endpoint once it is a real URL (or empty, for AWS). */
  endpointHint: string
  /** Shown instead while the pre-filled `<…>` placeholder is still in the endpoint. */
  placeholderHint?: string
  regionHint: string
}

export const S3_PRESETS: Record<S3Provider, Preset> = {
  aws: {
    label: 'AWS S3',
    endpoint: '',
    region: 'us-east-1',
    endpointHint: 'Leave empty for AWS; the region picks the endpoint.',
    regionHint: 'The bucket’s region, e.g. us-east-1 or eu-west-2.',
  },
  r2: {
    label: 'Cloudflare R2',
    endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    region: 'auto',
    endpointHint: 'Your account’s R2 S3 API endpoint.',
    placeholderHint: 'Replace <ACCOUNT_ID> with your Cloudflare account ID.',
    regionHint: 'R2 uses auto.',
  },
  b2: {
    label: 'Backblaze B2',
    endpoint: 'https://s3.<REGION>.backblazeb2.com',
    region: '',
    endpointHint: 'The S3 endpoint shown on the bucket.',
    placeholderHint: 'Replace <REGION> with the bucket’s region, e.g. https://s3.us-west-004.backblazeb2.com.',
    regionHint: 'The part of the endpoint after s3., e.g. us-west-004.',
  },
  other: {
    label: 'MinIO or other',
    endpoint: '',
    region: 'us-east-1',
    endpointHint: 'Any S3-compatible endpoint, e.g. http://localhost:9000.',
    regionHint: 'Most self-hosted servers accept us-east-1.',
  },
}

export type S3Draft = {
  provider: S3Provider
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** What the user typed this time. Never pre-filled: the stored key does not come back. */
  secret: string
  /** True when the user asked to remove the stored secret. */
  clearSecret: boolean
  pathStyle: PathStyleChoice
  /** Whether a secret is stored for this connection already. */
  hasSecret: boolean
}

export const BLANK_S3: S3Draft = {
  provider: 'aws',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secret: '',
  clearSecret: false,
  pathStyle: 'auto',
  hasSecret: false,
}

export function isS3(connection: Pick<Connection, 'kind' | 's3'> | null | undefined): boolean {
  return connection?.kind === 's3' && !!connection.s3
}

/** The provider a saved endpoint most likely belongs to, for the preset select. */
export function providerOf(endpoint: string | null): S3Provider {
  if (!endpoint) return 'aws'
  if (/\.r2\.cloudflarestorage\.com/i.test(endpoint)) return 'r2'
  if (/backblazeb2\.com/i.test(endpoint)) return 'b2'
  return 'other'
}

export function s3DraftFrom(connection: Connection): S3Draft {
  const s3 = connection.s3
  if (!s3) return BLANK_S3
  return {
    provider: providerOf(s3.endpoint),
    endpoint: s3.endpoint ?? '',
    region: s3.region,
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId ?? '',
    secret: '',
    clearSecret: false,
    pathStyle: s3.pathStyle === null ? 'auto' : s3.pathStyle ? 'on' : 'off',
    hasSecret: connection.hasSecret ?? false,
  }
}

/** Switching provider pre-fills its endpoint pattern and region; the bucket and keys stay. */
export function applyPreset(draft: S3Draft, provider: S3Provider): S3Draft {
  const preset = S3_PRESETS[provider]
  return { ...draft, provider, endpoint: preset.endpoint, region: preset.region }
}

const PLACEHOLDER = /[<>]/

/** The hint under the endpoint: the replace-the-placeholder instruction only while there is one to replace. */
export function endpointHint(draft: Pick<S3Draft, 'provider' | 'endpoint'>): string {
  const preset = S3_PRESETS[draft.provider]
  return PLACEHOLDER.test(draft.endpoint) && preset.placeholderHint ? preset.placeholderHint : preset.endpointHint
}

export type S3Field = 'bucket' | 'region' | 'endpoint'
export type S3Issue = { field: S3Field; message: string }

/** Everything that stops this draft from saving, each tied to its field. Empty when it can be saved. */
export function s3Issues(draft: S3Draft): S3Issue[] {
  const issues: S3Issue[] = []
  const bucket = draft.bucket.trim()
  if (!bucket) issues.push({ field: 'bucket', message: 'A bucket is required.' })
  else if (!/^[A-Za-z0-9._-]+$/.test(bucket)) {
    issues.push({ field: 'bucket', message: 'A bucket name is letters, digits, dots, hyphens and underscores.' })
  }
  if (!draft.region.trim()) issues.push({ field: 'region', message: 'A region is required.' })
  const endpoint = draft.endpoint.trim()
  if (endpoint) {
    if (PLACEHOLDER.test(endpoint)) issues.push({ field: 'endpoint', message: 'Replace the <…> part of the endpoint.' })
    else if (!/^https?:\/\/[^/\s]+/i.test(endpoint)) {
      issues.push({ field: 'endpoint', message: 'The endpoint must start with https:// (or http:// for a local server).' })
    }
  } else if (draft.provider !== 'aws') {
    issues.push({ field: 'endpoint', message: 'This provider needs an endpoint URL.' })
  }
  return issues
}

/**
 * The issue to show next to a field, if any. An empty required field is left
 * unflagged (the empty box says it) unless it is the endpoint, where a
 * pre-filled placeholder is exactly the thing nobody notices.
 */
export function fieldIssue(draft: S3Draft, field: S3Field): string | null {
  const issue = s3Issues(draft).find((candidate) => candidate.field === field)
  if (!issue) return null
  if (field !== 'endpoint' && !draft[field].trim()) return null
  return issue.message
}

/** What stops this draft from saving, in words; null when it can be saved. */
export function s3Problem(draft: S3Draft): string | null {
  return s3Issues(draft)[0]?.message ?? null
}

/** `s3://bucket/path`, for display. */
export function s3Url(bucket: string, path: string): string {
  return `s3://${bucket}/${path.replace(/^\/+/, '')}`
}

/** The readable form of a local <-> bucket sync, matching the main process's plan display. */
export function s3SyncCommand(source: string, destination: string, mirror: boolean): string {
  return `diskpush s3 sync${mirror ? ' --delete' : ''} ${source} ${destination}`
}

/** The `s3` settings and the write-only secret, as connections:save takes them. */
export function s3Payload(draft: S3Draft): {
  s3: {
    endpoint: string | null
    region: string
    bucket: string
    pathStyle: boolean | null
    accessKeyId: string | null
  }
  s3SecretAccessKey?: string | null
} {
  const secret = draft.secret.trim()
  return {
    s3: {
      endpoint: draft.endpoint.trim() || null,
      region: draft.region.trim() || 'us-east-1',
      bucket: draft.bucket.trim(),
      pathStyle: draft.pathStyle === 'auto' ? null : draft.pathStyle === 'on',
      accessKeyId: draft.accessKeyId.trim() || null,
    },
    // Absent keeps what is stored; null clears it; a value replaces it.
    ...(draft.clearSecret ? { s3SecretAccessKey: null } : secret ? { s3SecretAccessKey: secret } : {}),
  }
}

/**
 * Where a remote pane opens: the saved default path, else the login directory
 * for a server (`.`) or the root for a bucket, which has no home directory.
 */
export function defaultRemotePathOf(connection: Connection | undefined): string {
  return connection?.defaultRemotePath ?? (isS3(connection) ? '/' : '.')
}

/** The short detail shown under a connection's name: `s3://bucket` or `user@host`. */
export function connectionDetail(connection: Connection): string {
  if (isS3(connection)) return `s3://${connection.s3!.bucket}`
  return `${connection.username}@${connection.host}${connection.port !== 22 ? `:${connection.port}` : ''}`
}
