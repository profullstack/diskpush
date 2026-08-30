/**
 * Thin re-exports plus the one helper the transfer command needs that does
 * not belong in the engine: draining a dry run into a change list.
 */
export {
  RsyncArgError,
  intersectCapabilities,
  planTransfer,
  runPlan,
  runToCompletion,
  type ExecutionPlan,
} from '@diskpush/rsync-core'

import { runToCompletion, type ExecutionPlan } from '@diskpush/rsync-core'
import type { Change } from '@diskpush/schemas'

export async function summarizeChangesFrom(plan: ExecutionPlan): Promise<{
  changes: Change[]
  exitCode: number
  message: string
}> {
  const result = await runToCompletion(plan)
  return { changes: result.changes, exitCode: result.ok ? 0 : result.exitCode, message: result.message }
}
