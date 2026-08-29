import type { DiskPushStore } from '@diskpush/database'
import { JobStateSchema } from '@diskpush/schemas'
import { EXIT } from '../exit-codes.js'
import { formatBytes, table } from '../format.js'
import { failure, type Output } from '../output.js'
import { flagValue, numberFlag, type ParsedArgv } from '../parse-argv.js'

export async function runJobs(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const stateFlag = flagValue(parsed, '--state')
  const state = stateFlag ? JobStateSchema.parse(stateFlag) : undefined
  const limit = numberFlag(parsed, '--limit') ?? 20

  const jobs = await store.listJobs(limit, state)
  if (output.isJson) {
    output.json({ status: 'ok', jobs })
    return EXIT.ok
  }
  if (jobs.length === 0) {
    output.line('No transfer jobs recorded yet.')
    return EXIT.ok
  }
  output.line(
    table(
      jobs.map((job) => [
        job.id.slice(0, 8),
        job.state,
        render(job.source),
        render(job.destination),
        formatBytes(job.bytesTransferred),
        job.createdAt.slice(0, 19).replace('T', ' '),
      ]),
      ['ID', 'STATE', 'SOURCE', 'DESTINATION', 'MOVED', 'CREATED'],
    ),
  )
  return EXIT.ok
}

export async function runJob(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  const id = parsed.positionals[0]
  if (!id) return failure(output, 'Usage: diskpush job ID', EXIT.usage)

  const jobs = await store.listJobs(500)
  const job = jobs.find((candidate) => candidate.id === id || candidate.id.startsWith(id))
  if (!job) return failure(output, `No job matching ${JSON.stringify(id)}.`, EXIT.configuration)

  if (output.isJson) {
    output.json({ status: 'ok', job })
    return EXIT.ok
  }
  output.line(`Job:         ${job.id}`)
  output.line(`State:       ${job.state}`)
  output.line(`Source:      ${render(job.source)}`)
  output.line(`Destination: ${render(job.destination)}`)
  output.line(`Transferred: ${formatBytes(job.bytesTransferred)}`)
  output.line(`Exit code:   ${job.exitCode ?? '-'}`)
  if (job.errorSummary) output.line(`Error:       ${job.errorSummary}`)
  return EXIT.ok
}

function render(endpoint: import('@diskpush/schemas').Endpoint): string {
  if (endpoint.type === 'local') return endpoint.path
  return `${endpoint.host}:${endpoint.path}`
}
