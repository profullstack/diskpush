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

export const EndpointSchema = z.discriminatedUnion('type', [LocalEndpointSchema, SshEndpointSchema])

export type LocalEndpoint = z.infer<typeof LocalEndpointSchema>
export type SshEndpoint = z.infer<typeof SshEndpointSchema>
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
