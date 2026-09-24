/**
 * MediaAnalyzer for DiskPush: describe photos, videos, audio and documents with
 * https://mediaanalyzer.pro, write the descriptions next to the files, and
 * optionally sort the files into folders by what they show.
 *
 * Surfaces:
 *   CLI      diskpush mediaanalyzer login | logout | whoami | analyze DIR [--sort] | undo DIR
 *   TUI      `a` on a local file or folder
 *   desktop  right-click a local selection → Plugins; sign in under Plugins…
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  definePlugin,
  describeEntries,
  type ActionResult,
  type BaseContext,
  type CommandContext,
  type DiskpushPlugin,
  type EntryRef,
} from '@diskpush/plugin-api'
import { analyze, type AnalyzeReport } from './analyze.js'
import { undoLastSort } from './apply.js'
import { ENV_KEY, MediaAnalyzerClient, NotSignedIn, clearTokens, saveTokens } from './client.js'
import { STATE_DIR } from './library.js'
import { mediaKind, type Ffmpeg } from './media.js'
import { DEFAULT_SERVER, loopbackLogin, normalizeServer, pasteLogin, revokeToken, type Fetch } from './oauth.js'

export { analyze, batches, MAX_FILES_PER_REQUEST } from './analyze.js'
export { SIGNATURE, folderName, parseSidecar, sidecarText, sortIntoFolders, undoLastSort } from './apply.js'
export { MediaAnalyzerClient, chooseTier, ENV_KEY } from './client.js'
export { collectMedia, fileRef, loadState, STATE_DIR, STATE_FILE } from './library.js'
export { CLIENT_ID, DEFAULT_SERVER, authorizeUrl, pkcePair } from './oauth.js'

export type MediaAnalyzerOptions = {
  fetchImpl?: Fetch
  /** Undefined looks for ffmpeg on PATH; null pretends there is none. */
  ffmpeg?: Ffmpeg | null
  pollIntervalMs?: number
  deviceName?: string
  loginTimeoutMs?: number
}


// Read from this package's manifest (src/ and dist/ both sit one level below it),
// so the version shown in `diskpush plugins list` moves with every release.
const PACKAGE_VERSION: string = createRequire(import.meta.url)('../package.json').version
const appliesToMedia = (entries: readonly EntryRef[]) =>
  entries.some((entry) => entry.isDirectory || mediaKind(entry.name) !== null)

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createMediaAnalyzerPlugin(options: MediaAnalyzerOptions = {}): DiskpushPlugin {
  const clientFor = (ctx: BaseContext) =>
    new MediaAnalyzerClient({
      settings: ctx.settings,
      secrets: ctx.secrets,
      env: ctx.env,
      signal: ctx.signal,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })

  const deviceName = () => options.deviceName ?? `DiskPush on ${hostname()}`

  async function signIn(ctx: BaseContext, show?: (url: string) => void): Promise<ActionResult> {
    const client = clientFor(ctx)
    const server = await client.server()
    ctx.progress.update({ message: 'Waiting for you to approve DiskPush in the browser…' })
    const tokens = await loopbackLogin({
      server,
      deviceName: deviceName(),
      openUrl: ctx.openUrl,
      signal: ctx.signal,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.loginTimeoutMs ? { timeoutMs: options.loginTimeoutMs } : {}),
      ...(show ? { onUrl: show } : {}),
    })
    await saveTokens(ctx.secrets, tokens)
    const me = await client.me()
    return { ok: true, message: `Signed in to MediaAnalyzer as ${me.user.email}.` }
  }

  async function signOut(ctx: BaseContext): Promise<ActionResult> {
    const refreshToken = await ctx.secrets.get('refresh_token')
    if (refreshToken) {
      try {
        await revokeToken(await clientFor(ctx).server(), refreshToken, options.fetchImpl)
      } catch (error) {
        ctx.progress.log('warn', `Could not revoke the login on the server: ${describeError(error)}`)
      }
    }
    await clearTokens(ctx.secrets)
    await ctx.secrets.set('api_key', null)
    return { ok: true, message: 'Signed out of MediaAnalyzer.' }
  }

  const runAnalysis = async (
    ctx: BaseContext & { dir: string; entries: readonly EntryRef[] },
    sort: boolean,
  ): Promise<AnalyzeReport> => {
    const client = clientFor(ctx)
    if (!(await client.credential())) throw new NotSignedIn()
    return analyze({
      dir: ctx.dir,
      entries: ctx.entries,
      sort,
      client,
      settings: ctx.settings,
      progress: ctx.progress,
      signal: ctx.signal,
      ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    })
  }

  /** `analyze DIR` in the CLI means everything in DIR, as the folder's own contents. */
  const wholeDirectory = async (dir: string): Promise<EntryRef[]> =>
    describeEntries(dir, (await readdir(dir)).filter((name) => !name.startsWith('.')))

  const flag = (args: string[], name: string) => args.includes(name)
  const value = (args: string[], name: string) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const positional = (args: string[]) => args.filter((arg, index) => !arg.startsWith('-') && !['--server'].includes(args[index - 1] ?? ''))

  const fail = (ctx: CommandContext, message: string, code = 1) => {
    if (ctx.json) ctx.printJson({ ok: false, message })
    else ctx.warn(message)
    return code
  }

  return definePlugin({
    id: 'mediaanalyzer',
    name: 'MediaAnalyzer',
    version: PACKAGE_VERSION,
    description: 'Describe photos, videos, audio and documents with mediaanalyzer.pro, and sort them into folders by what they show.',
    settings: [
      { key: 'server', label: 'Server', type: 'string', default: DEFAULT_SERVER, description: 'The MediaAnalyzer server.' },
      {
        key: 'tier',
        label: 'Tier',
        type: 'enum',
        options: ['', 'standard', 'premium', 'byok'],
        default: '',
        description: 'Empty picks the first tier that is online, else your own provider key.',
      },
      { key: 'providerId', label: 'Provider key id', type: 'string', default: '', description: 'For the byok tier. Empty uses your first key.' },
      { key: 'folders', label: 'Folders', type: 'string', default: '', description: 'Comma-separated categories to sort into. Empty uses the server defaults.' },
      { key: 'api_key', label: 'API key', type: 'secret', description: `An ma_key_… key, instead of signing in. ${ENV_KEY} overrides it.` },
    ],
    async status(ctx) {
      const client = clientFor(ctx)
      const credential = await client.credential()
      if (!credential) return 'Not signed in.'
      try {
        const me = await client.me()
        return `Signed in as ${me.user.email} · $${me.available_usd.toFixed(2)} available`
      } catch (error) {
        if (error instanceof NotSignedIn) return 'Not signed in.'
        return `Signed in (${describeError(error)})`
      }
    },
    tasks: [
      { id: 'login', label: 'Sign in to MediaAnalyzer', run: (ctx) => signIn(ctx) },
      { id: 'logout', label: 'Sign out', run: (ctx) => signOut(ctx) },
    ],
    actions: [
      {
        id: 'analyze',
        label: 'Analyze media',
        description: 'Describe each photo and video, in a .description.txt beside it.',
        tuiKey: 'm',
        appliesTo: appliesToMedia,
        async run(ctx) {
          const report = await runAnalysis(ctx, false)
          return { ok: report.ok, message: report.message, changed: report.changed }
        },
      },
      {
        id: 'analyze-sort',
        label: 'Analyze and sort into folders',
        description: 'Describe each file, then move it and its description into a folder named for what it shows. Undoable.',
        tuiKey: 'f',
        appliesTo: appliesToMedia,
        async run(ctx) {
          const report = await runAnalysis(ctx, true)
          return { ok: report.ok, message: report.message, changed: report.changed }
        },
      },
      {
        id: 'undo-sort',
        label: 'Undo last sort',
        description: 'Put back the files the last sort in this folder moved.',
        tuiKey: 'u',
        appliesTo: (_entries, { dir }) => dir !== '' && existsSync(join(dir, STATE_DIR)),
        async run(ctx) {
          const report = await undoLastSort(ctx.dir)
          if (!report.journal) return { ok: false, message: 'No sort to undo in this folder.' }
          for (const skipped of report.skipped) ctx.progress.log('warn', skipped)
          return {
            ok: report.skipped.length === 0,
            message: `Put back ${report.restored} file${report.restored === 1 ? '' : 's'}${report.skipped.length ? `; ${report.skipped.length} could not be` : ''}.`,
            changed: report.restored > 0,
          }
        },
      },
    ],
    commands: [
      {
        name: 'login',
        summary: 'sign in with your browser (OAuth, PKCE)',
        usage: 'login [--paste] [--server URL]',
        async run(args, ctx) {
          const server = value(args, '--server')
          if (server) await ctx.settings.set('server', normalizeServer(server))
          try {
            const headless = flag(args, '--paste') || (process.platform === 'linux' && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY)
            if (headless) {
              const client = clientFor(ctx)
              const tokens = await pasteLogin({
                server: await client.server(),
                deviceName: deviceName(),
                show: (url) => ctx.warn(`Open this in a browser, approve DiskPush, and paste the code it shows:\n\n  ${url}\n`),
                readCode: () => ctx.prompt('Code: '),
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
              })
              await saveTokens(ctx.secrets, tokens)
              const me = await client.me()
              ctx.print(`Signed in to MediaAnalyzer as ${me.user.email}.`)
              return 0
            }
            const result = await signIn(ctx, (url) => ctx.warn(`Opening your browser. If it does not open, visit:\n  ${url}`))
            if (ctx.json) ctx.printJson(result)
            else ctx.print(result.message)
            return 0
          } catch (error) {
            return fail(ctx, describeError(error))
          }
        },
      },
      {
        name: 'logout',
        summary: 'sign out, and revoke this login on the server',
        usage: 'logout',
        async run(_args, ctx) {
          const result = await signOut(ctx)
          if (ctx.json) ctx.printJson(result)
          else ctx.print(result.message)
          return 0
        },
      },
      {
        name: 'whoami',
        summary: 'who you are signed in as, your credit, and the tiers',
        usage: 'whoami',
        async run(_args, ctx) {
          try {
            const client = clientFor(ctx)
            if (!(await client.credential())) throw new NotSignedIn()
            const me = await client.me()
            if (ctx.json) {
              ctx.printJson(me)
              return 0
            }
            ctx.print(`${me.user.email} on ${await client.server()}`)
            ctx.print(`  balance    $${me.balance_usd.toFixed(2)}  ($${me.available_usd.toFixed(2)} available)`)
            for (const tier of me.tiers) {
              ctx.print(`  tier       ${tier.id.padEnd(10)} $${tier.usd_per_file.toFixed(4)}/file  ${tier.online ? 'online' : 'offline'}`)
            }
            for (const provider of me.providers) ctx.print(`  provider   ${provider.id}  ${provider.label} (${provider.model})`)
            return 0
          } catch (error) {
            return fail(ctx, describeError(error))
          }
        },
      },
      {
        name: 'analyze',
        summary: 'describe every photo and video in DIR (recursively); --sort also files them into folders',
        usage: 'analyze DIR [--sort]',
        async run(args, ctx) {
          const [target] = positional(args)
          if (!target) return fail(ctx, 'usage: diskpush mediaanalyzer analyze DIR [--sort]', 64)
          const dir = resolve(ctx.cwd, target)
          try {
            const entries = await wholeDirectory(dir)
            const report = await runAnalysis({ ...ctx, dir, entries }, flag(args, '--sort'))
            if (ctx.json) ctx.printJson(report)
            else ctx.print(report.message)
            return report.ok ? 0 : 1
          } catch (error) {
            return fail(ctx, describeError(error))
          }
        },
      },
      {
        name: 'undo',
        summary: 'put back the files the last --sort in DIR moved',
        usage: 'undo DIR',
        async run(args, ctx) {
          const [target] = positional(args)
          if (!target) return fail(ctx, 'usage: diskpush mediaanalyzer undo DIR', 64)
          const report = await undoLastSort(resolve(ctx.cwd, target))
          if (ctx.json) ctx.printJson(report)
          else if (!report.journal) ctx.print('No sort to undo there.')
          else {
            ctx.print(`Put back ${report.restored} file${report.restored === 1 ? '' : 's'}.`)
            for (const skipped of report.skipped) ctx.warn(`  skipped ${skipped}`)
          }
          return report.skipped.length === 0 ? 0 : 1
        },
      },
      {
        name: 'key',
        summary: `use an API key (ma_key_…) instead of signing in; --clear forgets it`,
        usage: 'key [KEY] | key --clear',
        async run(args, ctx) {
          if (flag(args, '--clear')) {
            await ctx.secrets.set('api_key', null)
            ctx.print('API key forgotten.')
            return 0
          }
          // Asked for rather than taken from argv when it can be, so it stays
          // out of shell history and `ps`.
          const key = positional(args)[0] ?? (await ctx.prompt('API key (ma_key_…): '))?.trim()
          if (!key || !key.startsWith('ma_key_')) return fail(ctx, 'usage: diskpush mediaanalyzer key ma_key_…', 64)
          await ctx.secrets.set('api_key', key)
          ctx.print('API key saved.')
          return 0
        },
      },
    ],
  })
}

export const mediaAnalyzerPlugin = createMediaAnalyzerPlugin()
export default mediaAnalyzerPlugin
