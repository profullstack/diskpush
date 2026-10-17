/**
 * Turning a saved connection (or an ad-hoc `s3://bucket/key`) into a client.
 *
 * Credentials come from, in order: the connection's access key id and the
 * secret DiskPush stored for it; then the standard AWS variables
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), which is
 * the way to keep a key in a vault and out of DiskPush entirely.
 */
import type { S3ConnectionSettings } from '@diskpush/schemas'
import { S3Client, endpointUrl, type Fetch } from './client.js'
import type { Credentials } from './sigv4.js'

export const S3_SECRET_NAME = 's3SecretAccessKey'

export type Env = Readonly<Record<string, string | undefined>>

export class MissingS3Credentials extends Error {}

export function resolveS3Credentials(settings: Pick<S3ConnectionSettings, 'accessKeyId'>, storedSecret: string | null, env: Env, label: string): Credentials {
  const accessKeyId = settings.accessKeyId ?? env.AWS_ACCESS_KEY_ID ?? null
  const fromEnv = storedSecret === null
  const secretAccessKey = storedSecret ?? env.AWS_SECRET_ACCESS_KEY ?? null
  if (!accessKeyId || !secretAccessKey) {
    throw new MissingS3Credentials(
      `${label}: no S3 credentials. Save them with \`diskpush connections add\` (the secret is asked for), or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.`,
    )
  }
  return { accessKeyId, secretAccessKey, sessionToken: fromEnv ? (env.AWS_SESSION_TOKEN ?? null) : null }
}

export function s3ClientFor(settings: S3ConnectionSettings, storedSecret: string | null, env: Env, label: string, options: { fetch?: Fetch } = {}): S3Client {
  return new S3Client(
    { endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, pathStyle: settings.pathStyle },
    resolveS3Credentials(settings, storedSecret, env, label),
    options,
  )
}

/** Settings for an ad-hoc `s3://bucket/...` with no saved connection: AWS_ENDPOINT_URL(_S3) and AWS_REGION, as the AWS CLI reads them. */
export function adhocS3Settings(bucket: string, env: Env): S3ConnectionSettings {
  return {
    endpoint: env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL ?? null,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
    bucket,
    pathStyle: null,
    accessKeyId: null,
  }
}

/** `host` and `username` for an S3 connection row: the endpoint's host, and the bucket, so `bucket@host` reads naturally. */
export function s3DisplayFields(settings: Pick<S3ConnectionSettings, 'endpoint' | 'region' | 'bucket'>): { host: string; username: string; port: number } {
  const url = endpointUrl(settings)
  return { host: url.hostname, username: settings.bucket, port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443 }
}

/** Parses `s3://bucket/some/key` into bucket and path. */
export function parseS3Url(input: string): { bucket: string; path: string } | null {
  const m = /^s3:\/\/([^/]+)(\/.*)?$/i.exec(input)
  if (!m) return null
  return { bucket: m[1]!, path: m[2] ?? '/' }
}
