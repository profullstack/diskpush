/**
 * A MediaAnalyzer server small enough to read, on a real local port.
 *
 * It implements what DiskPush uses and checks what the real one checks: the
 * PKCE verifier against the challenge, the client id, the redirect URI, that a
 * refresh token works exactly once (and that replaying one revokes the whole
 * login), at most 50 files per upload, and credit. Tests drive the "browser"
 * through `approve`, which does what a person clicking Allow would.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

type Pending = { challenge: string; redirectUri: string; clientId: string }
type Uploaded = {
  client_ref: string
  name: string
  rel_path: string
  kind: string
  bytes: number
  frames?: number
  status: 'queued' | 'done' | 'error'
  category: string | null
  description: string | null
  tags: string[]
  error: string | null
  finished_at: string | null
  partSize: number
}

export type FakeOptions = {
  /** Files the account can pay for. */
  credit?: number
  /** Results appear only after this many polls of the files endpoint. */
  pollsBeforeResults?: number
  tiers?: { id: string; name: string; usd_per_file: number; model: string; online: boolean }[]
  categorize?: (name: string) => string
}

export class FakeMediaAnalyzer {
  server!: Server
  url = ''
  readonly codes = new Map<string, Pending>()
  readonly access = new Set<string>()
  readonly refresh = new Map<string, 'live' | 'spent'>()
  readonly scans = new Map<string, { id: string; tier: string; provider_key_id?: string; categories?: string[]; files: Uploaded[] }>()
  readonly uploadBatches: number[] = []
  readonly tokenRequests: Record<string, string>[] = []
  revoked: string[] = []
  familyRevoked = false
  apiKey = 'ma_key_test'
  credit: number
  polls = 0
  private counter = 0
  private clock = Date.parse('2026-09-24T00:00:00.000Z')

  constructor(private readonly options: FakeOptions = {}) {
    this.credit = options.credit ?? Infinity
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.adapt(req).then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise((resolve) => this.server.close(resolve))
  }

  private async adapt(req: IncomingMessage): Promise<Response> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name, value]) => typeof value === 'string' && !['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name),
      ),
    ) as Record<string, string>
    const request = new Request(new URL(req.url ?? '/', this.url), {
      method: req.method ?? 'GET',
      headers,
      ...(body && req.method !== 'GET' ? { body } : {}),
    })
    try {
      return await this.handle(request)
    } catch (error) {
      return json(500, { error: { code: 'internal', message: String(error) } })
    }
  }

  /** What the browser does when the user approves: the server issues a code and redirects. */
  async approve(authorizeUrl: string): Promise<void> {
    const url = new URL(authorizeUrl)
    const redirectUri = url.searchParams.get('redirect_uri')!
    const code = `code_${++this.counter}`
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge')!,
      redirectUri,
      clientId: url.searchParams.get('client_id')!,
    })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', url.searchParams.get('state')!)
    const response = await fetch(back)
    await response.text()
  }

  /** Makes every live access token stale, as an hour passing would. */
  expireAccessTokens(): void {
    this.access.clear()
  }

  private issue(): Response {
    const pair = { access_token: `ma_at_${++this.counter}`, refresh_token: `ma_rt_${++this.counter}` }
    this.access.add(pair.access_token)
    this.refresh.set(pair.refresh_token, 'live')
    return json(200, { ...pair, token_type: 'Bearer', expires_in: 3600 })
  }

  private authorized(request: Request): boolean {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    return token === this.apiKey || this.access.has(token)
  }

  private tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/api/v1/oauth/token' && request.method === 'POST') {
      const body = (await request.json()) as Record<string, string>
      this.tokenRequests.push(body)
      if (body.client_id !== 'diskpush') return json(400, { error: 'invalid_client', error_description: 'unknown client' })
      if (body.grant_type === 'authorization_code') {
        const pending = this.codes.get(body.code ?? '')
        this.codes.delete(body.code ?? '')
        const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url')
        if (!pending || pending.challenge !== challenge || pending.redirectUri !== body.redirect_uri || !body.device_name) {
          return json(400, { error: 'invalid_grant', error_description: 'bad code or verifier' })
        }
        return this.issue()
      }
      if (body.grant_type === 'refresh_token') {
        const status = this.refresh.get(body.refresh_token ?? '')
        if (status !== 'live' || this.familyRevoked) {
          // Replaying a spent token is theft as far as the server knows.
          if (status === 'spent') this.familyRevoked = true
          return json(400, { error: 'invalid_grant', error_description: 'refresh token already used' })
        }
        this.refresh.set(body.refresh_token!, 'spent')
        return this.issue()
      }
      return json(400, { error: 'unsupported_grant_type' })
    }

    if (path === '/api/v1/oauth/revoke' && request.method === 'POST') {
      const body = (await request.json()) as { token: string }
      this.revoked.push(body.token)
      this.refresh.set(body.token, 'spent')
      return json(200, {})
    }

    if (!this.authorized(request)) return json(401, { error: { code: 'unauthorized', message: 'Sign in again.' } })

    if (path === '/api/v1/me') {
      return json(200, {
        user: { email: 'ada@example.com' },
        balance_usd: 5,
        available_usd: 4.5,
        categories: ['Pets', 'Landscapes'],
        tiers: this.options.tiers ?? [
          { id: 'standard', name: 'Standard', usd_per_file: 0.002, model: 'm', online: false },
          { id: 'premium', name: 'Premium', usd_per_file: 0.01, model: 'm2', online: true },
        ],
        providers: [{ id: 'pk_1', label: 'My key', kind: 'openai', model: 'gpt' }],
      })
    }

    if (path === '/api/v1/scans' && request.method === 'POST') {
      const body = (await request.json()) as { name: string; tier: string; provider_key_id?: string; categories?: string[]; source: string }
      if (body.source !== 'api') return json(400, { error: { code: 'bad_source', message: 'source' } })
      const id = `scan_${++this.counter}`
      this.scans.set(id, { id, tier: body.tier, ...(body.provider_key_id ? { provider_key_id: body.provider_key_id } : {}), ...(body.categories ? { categories: body.categories } : {}), files: [] })
      return json(201, { scan: { id, name: body.name, tier: body.tier } })
    }

    const scanMatch = /^\/api\/v1\/scans\/([^/]+)(\/files)?$/.exec(path)
    const scan = scanMatch ? this.scans.get(decodeURIComponent(scanMatch[1]!)) : undefined
    if (scanMatch && !scan) return json(404, { error: { code: 'not_found', message: 'No such scan.' } })

    if (scan && scanMatch?.[2] && request.method === 'POST') {
      const form = await request.formData()
      const meta = JSON.parse(String(form.get('meta'))) as Omit<Uploaded, 'status' | 'category' | 'description' | 'tags' | 'error' | 'finished_at' | 'partSize'>[]
      if (meta.length > 50) return json(413, { error: { code: 'too_many_files', message: 'at most 50' } })
      this.uploadBatches.push(meta.length)
      const fresh = meta.filter((m) => !scan.files.some((f) => f.client_ref === m.client_ref))
      if (fresh.length > this.credit) {
        return json(402, { error: { code: 'insufficient_credit', message: 'Not enough credit for these files. Add credit under Billing.' } })
      }
      this.credit -= fresh.length
      const rejected: { client_ref: string; reason: string }[] = []
      meta.forEach((m, index) => {
        const part = form.get(`file${index}`)
        if (!(part instanceof Blob)) rejected.push({ client_ref: m.client_ref, reason: 'missing file part' })
        else if (fresh.includes(m)) {
          scan.files.push({ ...m, status: 'queued', category: null, description: null, tags: [], error: null, finished_at: null, partSize: part.size })
        }
      })
      return json(202, { accepted: fresh.length - rejected.length, duplicates: meta.length - fresh.length, rejected })
    }

    if (scan && scanMatch?.[2]) {
      this.polls += 1
      if (this.polls > (this.options.pollsBeforeResults ?? 0)) {
        for (const file of scan.files) {
          if (file.status !== 'queued') continue
          const failing = file.name.includes('broken')
          file.status = failing ? 'error' : 'done'
          file.error = failing ? 'not a readable image' : null
          file.category = failing ? null : (this.options.categorize ?? defaultCategory)(file.name)
          file.description = failing ? null : `A picture called ${file.name}.`
          file.tags = failing ? [] : ['test', file.kind]
          file.finished_at = this.tick()
        }
      }
      const raw = url.searchParams.get('finished_after') ?? ''
      const since = raw ? Date.parse(raw) : -Infinity
      const rows = scan.files
        .filter((file) => file.finished_at && Date.parse(file.finished_at) >= since)
        .sort((a, b) => a.finished_at!.localeCompare(b.finished_at!))
      return json(200, { files: rows, next_finished_after: rows.at(-1)?.finished_at ?? (raw || null) })
    }

    if (scan) {
      const done = scan.files.filter((file) => file.status === 'done').length
      const failed = scan.files.filter((file) => file.status === 'error').length
      return json(200, {
        scan: { id: scan.id, status: 'running', file_count: scan.files.length, done_count: done, error_count: failed, charged_usd: done * 0.01 },
      })
    }

    return json(404, { error: { code: 'not_found', message: path } })
  }
}

function defaultCategory(name: string): string {
  return /cat|dog/i.test(name) ? 'Pets' : 'Landscapes'
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
