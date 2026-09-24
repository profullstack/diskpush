/**
 * The MediaAnalyzer API, as DiskPush uses it.
 *
 * Credentials, in order of precedence:
 *   1. DISKPUSH_MEDIAANALYZER_KEY in the environment (an `ma_key_…` API key)
 *   2. an API key saved as the `api_key` secret
 *   3. the OAuth login: `access_token` + `refresh_token` secrets
 */
import type { PluginSecrets, PluginSettings } from '@diskpush/plugin-api'
import { ApiError, DEFAULT_SERVER, apiError, normalizeServer, refreshTokens, type Fetch, type Tokens } from './oauth.js'

export const ENV_KEY = 'DISKPUSH_MEDIAANALYZER_KEY'

/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000

export type Tier = { id: string; name: string; usd_per_file: number; model: string; online: boolean }
export type Provider = { id: string; label: string; kind: string; model: string }

export type Me = {
  user: { email: string }
  balance_usd: number
  available_usd: number
  categories: string[]
  tiers: Tier[]
  providers: Provider[]
}

export type UploadMeta = {
  client_ref: string
  name: string
  rel_path: string
  kind: 'photo' | 'video'
  bytes: number
  frames?: number
  duration_seconds?: number
}

export type UploadResult = {
  accepted: number
  duplicates: number
  rejected: { client_ref: string; reason: string }[]
}

export type FileResult = {
  client_ref: string
  status: 'done' | 'error' | string
  category: string | null
  description: string | null
  tags: string[] | null
  confidence?: number | null
  error?: string | null
}

export type ScanSummary = {
  id: string
  status: string
  file_count: number
  done_count: number
  error_count: number
  charged_usd: number
}

export type ClientOptions = {
  settings: PluginSettings
  secrets: PluginSecrets
  env: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  fetchImpl?: Fetch
}

export class NotSignedIn extends Error {
  constructor() {
    super('Not signed in to MediaAnalyzer. Run `diskpush mediaanalyzer login`, or sign in from Plugins in the desktop app.')
    this.name = 'NotSignedIn'
  }
}

/** Stores a fresh token pair. Called the moment one arrives: see oauth.ts on rotation. */
export async function saveTokens(secrets: PluginSecrets, tokens: Tokens, now = Date.now()): Promise<void> {
  await secrets.set('refresh_token', tokens.refresh_token)
  await secrets.set('access_token', tokens.access_token)
  await secrets.set('access_expires_at', String(now + Math.max(0, tokens.expires_in) * 1000))
}

export async function clearTokens(secrets: PluginSecrets): Promise<void> {
  await secrets.set('access_token', null)
  await secrets.set('access_expires_at', null)
  await secrets.set('refresh_token', null)
}

export class MediaAnalyzerClient {
  private readonly fetchImpl: Fetch
  private refreshing: Promise<string> | null = null

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async server(): Promise<string> {
    return normalizeServer(await this.options.settings.get('server', DEFAULT_SERVER))
  }

  /** How this client authenticates, without revealing the credential. */
  async credential(): Promise<'env-key' | 'api-key' | 'oauth' | null> {
    if (this.options.env[ENV_KEY]) return 'env-key'
    if (await this.options.secrets.get('api_key')) return 'api-key'
    if (await this.options.secrets.get('refresh_token')) return 'oauth'
    return null
  }

  private async bearer(forceRefresh = false): Promise<string> {
    const envKey = this.options.env[ENV_KEY]
    if (envKey) return envKey
    const apiKey = await this.options.secrets.get('api_key')
    if (apiKey) return apiKey

    const access = await this.options.secrets.get('access_token')
    const expiresAt = Number(await this.options.secrets.get('access_expires_at'))
    if (!forceRefresh && access && Number.isFinite(expiresAt) && expiresAt - EXPIRY_MARGIN_MS > Date.now()) return access
    return this.refresh()
  }

  /** One refresh at a time: two concurrent ones would present the same token twice and revoke the login. */
  private refresh(): Promise<string> {
    this.refreshing ??= (async () => {
      try {
        // Read again rather than trusting memory: the other surface may have
        // rotated it since this one started.
        const refreshToken = await this.options.secrets.get('refresh_token')
        if (!refreshToken) throw new NotSignedIn()
        let tokens: Tokens
        try {
          tokens = await refreshTokens(await this.server(), refreshToken, this.fetchImpl)
        } catch (error) {
          if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
            await clearTokens(this.options.secrets)
            throw new NotSignedIn()
          }
          throw error
        }
        await saveTokens(this.options.secrets, tokens)
        return tokens.access_token
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** One API call, retried once with a refreshed token if the access token was turned away. */
  async request<T>(method: string, path: string, body?: { json?: unknown; form?: FormData }): Promise<T> {
    const send = async (token: string) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
      let payload: string | FormData | undefined
      if (body?.json !== undefined) {
        headers['content-type'] = 'application/json'
        payload = JSON.stringify(body.json)
      } else if (body?.form) {
        payload = body.form
      }
      return this.fetchImpl(new URL(path, await this.server()), {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      })
    }

    let response = await send(await this.bearer())
    if (response.status === 401 && (await this.credential()) === 'oauth') {
      response = await send(await this.bearer(true))
    }
    if (!response.ok) throw await apiError(response)
    return (await response.json()) as T
  }

  me(): Promise<Me> {
    return this.request<Me>('GET', '/api/v1/me')
  }

  async createScan(input: { name: string; tier: string; provider_key_id?: string; categories?: string[] }): Promise<{ id: string }> {
    const result = await this.request<{ scan: { id: string } }>('POST', '/api/v1/scans', {
      json: { ...input, source: 'api' },
    })
    return result.scan
  }

  uploadFiles(scanId: string, form: FormData): Promise<UploadResult> {
    return this.request<UploadResult>('POST', `/api/v1/scans/${encodeURIComponent(scanId)}/files`, { form })
  }

  files(scanId: string, finishedAfter: string): Promise<{ files: FileResult[]; next_finished_after: string | null }> {
    const query = new URLSearchParams({ finished_after: finishedAfter })
    return this.request('GET', `/api/v1/scans/${encodeURIComponent(scanId)}/files?${query}`)
  }

  async scan(scanId: string): Promise<ScanSummary> {
    return (await this.request<{ scan: ScanSummary }>('GET', `/api/v1/scans/${encodeURIComponent(scanId)}`)).scan
  }
}

/**
 * The tier to scan with: the setting if there is one, else the first tier the
 * server says is online, else bring-your-own-key with the first provider.
 */
export function chooseTier(
  me: Me,
  setting: { tier: string; providerId: string },
): { tier: string; provider_key_id?: string } {
  const providerId = setting.providerId || me.providers[0]?.id
  if (setting.tier) {
    if (setting.tier === 'byok') {
      if (!providerId) throw new Error('Tier "byok" needs a provider key; add one at MediaAnalyzer first.')
      return { tier: 'byok', provider_key_id: providerId }
    }
    return { tier: setting.tier }
  }
  const online = me.tiers.find((tier) => tier.online)
  if (online) return { tier: online.id }
  if (providerId) return { tier: 'byok', provider_key_id: providerId }
  throw new Error('No MediaAnalyzer tier is online right now, and you have no provider key for bring-your-own-key.')
}
