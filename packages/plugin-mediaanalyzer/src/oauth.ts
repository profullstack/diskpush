/**
 * Signing in: OAuth 2.1 authorization code with PKCE (S256) and a loopback
 * redirect, the same flow the MediaAnalyzer CLI uses, as the `diskpush` client.
 *
 *   1. listen on 127.0.0.1:<random port>
 *   2. open /oauth/authorize in the browser with a code challenge and a state
 *   3. the browser comes back to http://127.0.0.1:<port>/callback?code&state
 *   4. POST the code and the verifier to /api/v1/oauth/token
 *
 * Refresh tokens rotate: each one works exactly once, and presenting a spent
 * one revokes the whole login. So the new pair is stored the moment it
 * arrives, before anything else can fail.
 *
 * Where no browser can reach this machine (an ssh session), the headless
 * variant uses `${server}/oauth/code` as the redirect, which shows the code on
 * the page for the user to paste.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const CLIENT_ID = 'diskpush'
export const DEFAULT_SERVER = 'https://mediaanalyzer.pro'

export type Tokens = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

export type Fetch = typeof fetch

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function normalizeServer(server: string): string {
  const url = new URL(server)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('The MediaAnalyzer server must be https (or http on localhost).')
  }
  return url.origin
}

export function authorizeUrl(
  server: string,
  options: { redirectUri: string; challenge: string; state: string; deviceName: string },
): string {
  const url = new URL('/oauth/authorize', server)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: options.redirectUri,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    state: options.state,
    device_name: options.deviceName,
  }).toString()
  return url.toString()
}

/** Parses an error envelope, `{error:{code,message}}`, into an ApiError. */
export async function apiError(response: Response): Promise<ApiError> {
  let code: string | null = null
  let message = `${response.status} ${response.statusText}`.trim()
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } | string; error_description?: string }
    if (body.error && typeof body.error === 'object') {
      code = body.error.code ?? null
      message = body.error.message ?? message
    } else if (typeof body.error === 'string') {
      // RFC 6749 token errors: {error: "invalid_grant", error_description}.
      code = body.error
      message = body.error_description ?? body.error
    }
  } catch {
    // Not JSON: the status line is all there is.
  }
  return new ApiError(message, response.status, code)
}

async function tokenRequest(server: string, body: Record<string, string>, fetchImpl: Fetch): Promise<Tokens> {
  const response = await fetchImpl(new URL('/api/v1/oauth/token', server), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await apiError(response)
  const tokens = (await response.json()) as Tokens
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('The token endpoint returned no tokens.')
  return tokens
}

export function exchangeCode(
  server: string,
  options: { code: string; verifier: string; redirectUri: string; deviceName: string },
  fetchImpl: Fetch = fetch,
): Promise<Tokens> {
  return tokenRequest(
    server,
    {
      grant_type: 'authorization_code',
      code: options.code,
      code_verifier: options.verifier,
      client_id: CLIENT_ID,
      redirect_uri: options.redirectUri,
      device_name: options.deviceName,
    },
    fetchImpl,
  )
}

export function refreshTokens(server: string, refreshToken: string, fetchImpl: Fetch = fetch): Promise<Tokens> {
  return tokenRequest(server, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }, fetchImpl)
}

export async function revokeToken(server: string, token: string, fetchImpl: Fetch = fetch): Promise<void> {
  const response = await fetchImpl(new URL('/api/v1/oauth/revoke', server), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  // Revoking something already gone is still signed out.
  if (!response.ok && response.status !== 400 && response.status !== 404) throw await apiError(response)
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;text-align:center">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`

export type LoopbackOptions = {
  server: string
  deviceName: string
  openUrl: (url: string) => Promise<void>
  signal: AbortSignal
  /** How long to wait for the browser. */
  timeoutMs?: number
  fetchImpl?: Fetch
  /** Told the URL too, for a surface that can print it in case the browser did not open. */
  onUrl?: (url: string) => void
}

/** The loopback flow, end to end. Resolves with the tokens. */
export async function loopbackLogin(options: LoopbackOptions): Promise<Tokens> {
  const { verifier, challenge } = pkcePair()
  const state = base64url(randomBytes(16))

  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void }
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    // A state that does not match is somebody else's redirect; it answers
    // nothing and ends nothing.
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/html' }).end(PAGE('Sign-in failed', 'That link was not for this sign-in.'))
      return
    }
    if (error || !code) {
      response.writeHead(400, { 'content-type': 'text/html' }).end(PAGE('Sign-in cancelled', 'You can close this tab.'))
      settle.reject(new Error(error === 'access_denied' ? 'Sign-in was declined.' : `Sign-in failed: ${error ?? 'no code'}`))
      return
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(PAGE('DiskPush is signed in to MediaAnalyzer', 'You can close this tab and go back to DiskPush.'))
    settle.resolve(code)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}/callback`

  const onAbort = () => settle.reject(new Error('Sign-in cancelled.'))
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => settle.reject(new Error('Timed out waiting for the browser.')), options.timeoutMs ?? 5 * 60_000)

  try {
    const url = authorizeUrl(options.server, { redirectUri, challenge, state, deviceName: options.deviceName })
    options.onUrl?.(url)
    await options.openUrl(url)
    const code = await codePromise
    return await exchangeCode(options.server, { code, verifier, redirectUri, deviceName: options.deviceName }, options.fetchImpl)
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
    server.closeAllConnections()
    server.close()
  }
}

/**
 * The headless flow: the server shows the code instead of redirecting to this
 * machine. `readCode` asks the user for it.
 */
export async function pasteLogin(options: {
  server: string
  deviceName: string
  show: (url: string) => void
  readCode: () => Promise<string | null>
  fetchImpl?: Fetch
}): Promise<Tokens> {
  const { verifier, challenge } = pkcePair()
  const state = base64url(randomBytes(16))
  const redirectUri = new URL('/oauth/code', options.server).toString()
  options.show(authorizeUrl(options.server, { redirectUri, challenge, state, deviceName: options.deviceName }))
  const code = (await options.readCode())?.trim()
  if (!code) throw new Error('No code entered.')
  return exchangeCode(options.server, { code, verifier, redirectUri, deviceName: options.deviceName }, options.fetchImpl)
}
