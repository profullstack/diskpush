import { describe, expect, it } from 'vitest'
import { runToCompletion } from './runner.js'
import type { ExecutionPlan } from './plan.js'

function plan(binary: string, args: string[]): ExecutionPlan {
  return {
    binary,
    args,
    rsyncArgs: args,
    topology: 'local-to-local',
    display: `${binary} ${args.join(' ')}`,
    warnings: [],
    direct: true,
  }
}

describe('runPlan', () => {
  it('reports a missing binary once, with a message a person can act on', async () => {
    const result = await runToCompletion(plan('definitely-not-a-real-binary-xyz', []))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/could not find definitely-not-a-real-binary-xyz/i)
  })

  it('emits exactly one exit event for a failed spawn', async () => {
    const exits: unknown[] = []
    await runToCompletion(plan('definitely-not-a-real-binary-xyz', []), {}, (event) => {
      if (event.type === 'exit') exits.push(event)
    })
    // A failed spawn fires both `error` and `close`; only one exit may escape,
    // or the second overwrites the useful message with a generic one.
    expect(exits).toHaveLength(1)
  })

  it('passes a real exit code straight through', async () => {
    const result = await runToCompletion(plan('sh', ['-c', 'exit 23']))
    expect(result.exitCode).toBe(23)
    expect(result.resumable).toBe(true)
  })
})
