import { z } from 'zod'

/**
 * An endpoint is one side of a transfer. It is deliberately NOT a string:
 * strings get concatenated, and concatenation is how shell injection happens.
 */
export const LocalEndpointSchema = z.object({
  type: z.literal('local'),
  path: z.string().min(1),
})

export const SshEndpointSchema = z.object({
  type: z.literal('ssh'),
  /** Saved connection id, when this endpoint came from the connection manager. */
  connectionId: z.string().min(1).optional(),
  /** Host or ssh_config alias. Required once resolved. */
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string().min(1),
})

/**
 * A path in an S3-compatible bucket. `path` is a POSIX path inside the bucket
 * (`/backups/db/`); a trailing `/` means the same as it does to rsync.
 */
export const S3EndpointSchema = z.object({
  type: z.literal('s3'),
  /** Saved connection id; absent for an ad-hoc `s3://bucket/key` using AWS_* variables. */
  connectionId: z.string().min(1).optional(),
  /** The connection's name, or the bucket for an ad-hoc endpoint. For display. */
  name: z.string().min(1),
  bucket: z.string().min(1),
  path: z.string().min(1),
})

export const EndpointSchema = z.discriminatedUnion('type', [LocalEndpointSchema, SshEndpointSchema, S3EndpointSchema])

export type LocalEndpoint = z.infer<typeof LocalEndpointSchema>
export type SshEndpoint = z.infer<typeof SshEndpointSchema>
export type S3Endpoint = z.infer<typeof S3EndpointSchema>
export type Endpoint = z.infer<typeof EndpointSchema>

/**
 * How a job's two endpoints combine. `remote-to-remote` is the direct
 * server-to-server case, which rsync cannot express in one local invocation.
 */
export type TransferTopology = 'local-to-local' | 'local-to-remote' | 'remote-to-local' | 'remote-to-remote'

export function topologyOf(source: Endpoint, destination: Endpoint): TransferTopology {
  if (source.type === 'local' && destination.type === 'local') return 'local-to-local'
  if (source.type === 'local') return 'local-to-remote'
  if (destination.type === 'local') return 'remote-to-local'
  return 'remote-to-remote'
}

/** True when either side is a bucket: the transfer runs on the S3 engine, not rsync. */
export function involvesS3(source: Endpoint, destination: Endpoint): boolean {
  return source.type === 's3' || destination.type === 's3'
}

/** `s3://bucket/path`, for display. */
export function renderS3Endpoint(endpoint: S3Endpoint): string {
  return `s3://${endpoint.bucket}/${endpoint.path.replace(/^\/+/, '')}`
}
