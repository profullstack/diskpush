import type { DiskPushStore } from '@diskpush/database'
import { EXIT } from '../exit-codes.js'
import { failure, type Output } from '../output.js'
import { flagValue, type ParsedArgv } from '../parse-argv.js'
import { resolveEndpoint } from '../resolve.js'
import { blankPane, defaultLocalPath, Tui } from '../tui/app.js'
import { parseKeys } from '../tui/keys.js'
import { ansi } from '../tui/render.js'

/**
 * `diskpush tui` — the two-pane browser, in a terminal.
 *
 *   diskpush tui                       local beside the current directory
 *   diskpush tui prod:/srv/app         local beside a server
 *   diskpush tui ./dist prod:/srv/app  both sides named
 */
export async function runTui(parsed: ParsedArgv, store: DiskPushStore, output: Output): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return failure(output, 'diskpush tui needs an interactive terminal.', EXIT.usage)
  }

  const [first, second] = parsed.positionals
  const sides = second ? [first!, second] : [defaultLocalPath(), first ?? defaultLocalPath()]

  const panes = []
  for (const target of sides) {
    const resolved = await resolveEndpoint(store, target)
    if (resolved.endpoint.type === 'local') {
      panes.push(blankPane('Local', resolved.endpoint.path))
      continue
    }
    if (!resolved.connection) {
      return failure(
        output,
        `${resolved.endpoint.host} is neither a saved connection nor a host in ~/.ssh/config.`,
        EXIT.configuration,
      )
    }
    panes.push(blankPane(resolved.connection.name, resolved.endpoint.path, resolved.connection))
  }

  const tui = new Tui(panes[0]!, panes[1]!)

  const restore = () => {
    process.stdout.write(ansi.showCursor + ansi.mainScreen)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
  }

  process.stdout.write(ansi.altScreen + ansi.hideCursor)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  const onResize = () => tui.render()
  process.stdout.on('resize', onResize)

  try {
    await tui.loadBoth()
    tui.render()

    await new Promise<void>((resolve) => {
      const onData = (chunk: string) => {
        // Several keys can arrive in one chunk, and an arrow key is three
        // bytes; parseKeys turns the raw bytes into logical keys first.
        void (async () => {
          for (const key of parseKeys(chunk)) {
            const keepGoing = await tui.onKey(key)
            if (!keepGoing) {
              process.stdin.off('data', onData)
              resolve()
              return
            }
          }
          tui.render()
        })()
      }
      process.stdin.on('data', onData)
    })
  } finally {
    process.stdout.off('resize', onResize)
    tui.close()
    restore()
  }

  return EXIT.ok
}
