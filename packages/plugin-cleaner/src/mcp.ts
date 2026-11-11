/**
 * The cleaner as an MCP server: `diskpush clean mcp` speaks MCP over stdio
 * (newline-delimited JSON-RPC 2.0), so an agent can ask what is filling a
 * disk and free space with the same guards as everyone else.
 *
 * Tools:
 *   clean_targets   this machine and the servers DiskPush knows
 *   clean_report    read-only analysis of one target
 *   clean_apply     dry run unless `apply: true`; only eligible, safe-class items
 *
 * Written against the protocol directly (it is small) so the CLI gains no
 * dependency. Nothing but protocol messages is written to stdout.
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { BaseContext } from '@diskpush/plugin-api'
import { applyClean, listTargets, scanTarget, LOCAL_TARGET, type CleanOptions, type Runner } from './api.js'
import { formatApply, formatReport } from './format.js'
import { CLEAN_CATEGORIES, parseCategories } from './model.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

const categories = { type: 'array', items: { type: 'string', enum: [...CLEAN_CATEGORIES] }, description: 'Limit to these categories. Default: all of them.' }
const target = { type: 'string', description: `"${LOCAL_TARGET}" (this machine, the default) or a server name from clean_targets.` }

export const MCP_TOOLS = [
  {
    name: 'clean_targets',
    description: 'List the machines the cleaner can work on: this machine ("local") and every server DiskPush knows (saved connections and ~/.ssh/config hosts).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'clean_report',
    description:
      'Read-only disk analysis of a target: filesystems and free space, the biggest directories, which processes are writing to disk right now, growth since the last report, and every finding classified as safe (regenerable), safe-if-idle, or needs-a-human, ranked by bytes freed per unit of risk, each with the reason it is or is not safe and a suggested command. Deletes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        only: categories,
        idleDays: { type: 'integer', minimum: 1, description: 'A project counts as idle after this many days without a changed file. Default 3.' },
        sampleSeconds: { type: 'integer', minimum: 0, maximum: 30, description: 'How long to watch disk writers. Default 3.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'clean_apply',
    description:
      'Free space on a target. Scans first, then removes ONLY eligible items in the safe classes (caches, docker build cache and old unused images, rotated logs, idle build output, stale partial files), re-checking every guard at the moment of deletion. Needs-a-human items (databases, backups, volumes, media, stopped containers) are never touched. Without apply: true it is a dry run that lists exactly what would be removed.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        apply: { type: 'boolean', description: 'Must be true to delete anything. Anything else is a dry run.' },
        only: categories,
        ids: { type: 'array', items: { type: 'string' }, description: 'Only these item ids from a clean_report.' },
        idleDays: { type: 'integer', minimum: 1 },
        minFreeGb: { type: 'number', minimum: 0, description: 'Do nothing when this much is free already, and stop once it is.' },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
] as const

type Json = Record<string, unknown>

function text(value: string, structured?: unknown, isError = false): Json {
  return { content: [{ type: 'text', text: value }], ...(structured === undefined ? {} : { structuredContent: structured }), ...(isError ? { isError: true } : {}) }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function cats(value: unknown) {
  return Array.isArray(value) ? parseCategories(value.filter((v) => typeof v === 'string').join(',')) : undefined
}

export async function callTool(ctx: BaseContext, name: string, args: Json, runner?: Runner): Promise<Json> {
  try {
    if (name === 'clean_targets') {
      const targets = await listTargets(ctx)
      return text(targets.map((t) => `${t.name}${t.host ? ` (${t.host})` : ''}${t.usable ? '' : `: ${t.reason}`}`).join('\n'), { targets })
    }
    const options: CleanOptions = {
      ...(cats(args.only) ? { only: cats(args.only)! } : {}),
      ...(int(args.idleDays) ? { idleDays: int(args.idleDays)! } : {}),
      ...(int(args.sampleSeconds) !== undefined ? { sampleSeconds: Math.min(30, int(args.sampleSeconds)!) } : {}),
      ...(typeof args.minFreeGb === 'number' && args.minFreeGb > 0 ? { minFreeGb: args.minFreeGb } : {}),
      ...(runner ? { runner } : {}),
    }
    const report = await scanTarget(ctx, str(args.target) ?? LOCAL_TARGET, options)
    if (name === 'clean_report') return text(formatReport(report, { limit: 40 }).join('\n'), report)
    if (name === 'clean_apply') {
      const result = await applyClean(ctx, report, {
        apply: args.apply === true,
        ...(options.only ? { only: options.only } : {}),
        ...(Array.isArray(args.ids) ? { ids: args.ids.filter((v): v is string => typeof v === 'string') } : {}),
        ...(options.minFreeGb ? { minFreeGb: options.minFreeGb } : {}),
        ...(runner ? { runner } : {}),
      })
      const titles = new Map(report.items.map((i) => [i.id, i.title]))
      return text(formatApply(result, titles).join('\n').replace('Run again with --apply', 'Call again with apply: true'), result)
    }
    return text(`No tool called ${name}.`, undefined, true)
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), undefined, true)
  }
}

/** Serves MCP on `input`/`output` until input ends. */
export async function serveMcp(ctx: BaseContext, input: Readable, output: Writable, info: { version: string }, runner?: Runner): Promise<void> {
  const send = (message: Json) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const lines = createInterface({ input, crlfDelay: Infinity })
  const pending: Promise<void>[] = []
  for await (const line of lines) {
    if (!line.trim()) continue
    let message: { id?: string | number | null; method?: string; params?: Json }
    try {
      message = JSON.parse(line)
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    const { id, method, params = {} } = message
    const isRequest = id !== undefined && id !== null
    const reply = (result: Json) => isRequest && send({ id, result })
    const fail = (code: number, text: string) => isRequest && send({ id, error: { code, message: text } })
    switch (method) {
      case 'initialize':
        reply({
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'diskpush-cleaner', version: info.version },
          instructions: 'Call clean_report first and read each item\'s safety and reason. clean_apply deletes only with apply: true, and only safe-class items.',
        })
        break
      case 'ping':
        reply({})
        break
      case 'tools/list':
        reply({ tools: MCP_TOOLS })
        break
      case 'tools/call':
        pending.push(
          callTool(ctx, String(params.name ?? ''), (params.arguments as Json) ?? {}, runner).then((result) => {
            reply(result)
          }),
        )
        break
      default:
        if (method?.startsWith('notifications/')) break
        fail(-32601, `Method not found: ${method}`)
    }
  }
  await Promise.all(pending)
}
