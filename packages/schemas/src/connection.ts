import { z } from 'zod'

export const AuthTypeSchema = z.enum(['agent', 'key', 'key-passphrase', 'password'])
export type AuthType = z.infer<typeof AuthTypeSchema>

export const ConnectionSchema = z.object({
  id: z.string().min(1),
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
}).partial({ port: true, authType: true, connectTimeoutSeconds: true, forwardAgent: true, tags: true, notes: true })

export type ConnectionInput = z.input<typeof ConnectionInputSchema>

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
