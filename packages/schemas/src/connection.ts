import { z } from 'zod'

export const AuthTypeSchema = z.enum(['agent', 'key', 'key-passphrase', 'password'])
export type AuthType = z.infer<typeof AuthTypeSchema>

/** What a saved connection reaches: a server over SSH, or an S3-compatible bucket. */
export const ConnectionKindSchema = z.enum(['ssh', 's3'])
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>

/**
 * Where an S3 connection points. The secret access key is NOT here: it lives
 * in the settings store's secret rows (or AWS_SECRET_ACCESS_KEY), like every
 * other credential DiskPush keeps.
 */
export const S3ConnectionSettingsSchema = z.object({
  /** `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com` … Null is AWS. */
  endpoint: z.string().url().nullable().default(null),
  /** `us-east-1`; `auto` for Cloudflare R2. */
  region: z.string().min(1).default('us-east-1'),
  bucket: z.string().min(1).max(255),
  /** Null decides: path-style for custom endpoints, virtual-hosted for AWS. */
  pathStyle: z.boolean().nullable().default(null),
  /** Null reads AWS_ACCESS_KEY_ID. */
  accessKeyId: z.string().min(1).nullable().default(null),
})
export type S3ConnectionSettings = z.infer<typeof S3ConnectionSettingsSchema>

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  kind: ConnectionKindSchema.default('ssh'),
  /** Present exactly when `kind` is `s3`. `host` is then the endpoint's host and `username` the bucket, for display. */
  s3: S3ConnectionSettingsSchema.nullable().default(null),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  authType: AuthTypeSchema.default('agent'),
  keyPath: z.string().min(1).nullable().default(null),
  defaultLocalPath: z.string().min(1).nullable().default(null),
  defaultRemotePath: z.string().min(1).nullable().default(null),
  /** ProxyJump target, e.g. `bastion` or `user@bastion:2222`. */
  jumpHost: z.string().min(1).nullable().default(null),
  rsyncPath: z.string().min(1).nullable().default(null),
  connectTimeoutSeconds: z.number().int().positive().default(15),
  keepaliveSeconds: z.number().int().positive().nullable().default(30),
  /** Opt-in per connection: forwarding an agent widens blast radius. */
  forwardAgent: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  notes: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Connection = z.infer<typeof ConnectionSchema>

export const ConnectionInputSchema = ConnectionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial({ kind: true, s3: true, port: true, authType: true, connectTimeoutSeconds: true, forwardAgent: true, tags: true, notes: true })

export type ConnectionInput = z.input<typeof ConnectionInputSchema>

export type S3Connection = Connection & { kind: 's3'; s3: S3ConnectionSettings }

export function isS3Connection(connection: Pick<Connection, 'kind' | 's3'> | null | undefined): connection is S3Connection {
  return connection?.kind === 's3' && connection.s3 !== null
}

/** The settings key a connection secret is kept under. */
export const connectionSecretKey = (connectionId: string, name: string) => `connection-secret:${connectionId}:${name}`

/** Capability report from probing a host's rsync + SFTP. */
export const RemoteCapabilitiesSchema = z.object({
  ssh: z.boolean(),
  sftp: z.boolean(),
  rsync: z.boolean(),
  rsyncVersion: z.string().nullable(),
  protocolVersion: z.number().nullable(),
  zstd: z.boolean(),
  acls: z.boolean(),
  xattrs: z.boolean(),
  hardLinks: z.boolean(),
  secludedArgs: z.boolean(),
  mkpath: z.boolean(),
})

export type RemoteCapabilities = z.infer<typeof RemoteCapabilitiesSchema>
