import { z } from 'zod'

/**
 * A saved set of servers.
 *
 * Tags describe what a server *is*; a list is a set someone assembled by hand
 * and wants back. "the four boxes behind the EU load balancer" is not a
 * property of any one of them, and re-ticking it every time is the friction
 * this removes.
 *
 * Members are stored by connection id **and** by the name they had when the
 * list was saved. The id is what resolves; the name is what makes the list
 * readable after a connection is deleted, so a member that has gone away can
 * be named rather than silently dropped — the same rule the selector follows,
 * where a term matching nothing is an error rather than a smaller fleet.
 */

export const FleetListMemberSchema = z.object({
  connectionId: z.string().min(1),
  /** The name at save time. Refreshed whenever the list is saved again. */
  connectionName: z.string().min(1),
})
export type FleetListMember = z.infer<typeof FleetListMemberSchema>

export const FleetListSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  members: z.array(FleetListMemberSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FleetList = z.infer<typeof FleetListSchema>

/**
 * How a list is named in a selector: `list:production`.
 *
 * Prefixed rather than bare, so a list can share a name with a server without
 * either shadowing the other. `--on production` is the server; `--on
 * list:production` is the list.
 */
export const FLEET_LIST_PREFIX = 'list:'

export function isListTerm(term: string): boolean {
  return term.startsWith(FLEET_LIST_PREFIX)
}

export function listTermName(term: string): string {
  return term.slice(FLEET_LIST_PREFIX.length)
}
