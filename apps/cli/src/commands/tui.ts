import { createApp } from '@profullstack/hqtui'
import type { DiskPushStore } from '@diskpush/database'
import { EXIT } from '../exit-codes.js'
import { failure, type Output } from '../output.js'
import { type ParsedArgv } from '../parse-argv.js'
import { resolveEndpoint, sshConfigHosts } from '../resolve.js'
import { blankPane, buildEndpointChoices, defaultLocalPath, Tui } from '../tui/app.js'
import { runInherited } from '../tui/launch.js'

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

  const choices = buildEndpointChoices(await store.listConnections(), sshConfigHosts(), defaultLocalPath())
  const tui = new Tui(panes[0]!, panes[1]!, choices)

  try {
    void tui.loadBoth()
    // The browser runs until it quits, or until it wants the terminal handed
    // to a program — `e` outside tmux. Then the program runs with the screen
    // to itself and the browser starts again, every pane where it was.
    for (;;) {
      await runApp(tui)
      const handoff = tui.takeHandoff()
      if (!handoff) break
      try {
        await runInherited(handoff)
      } catch (error) {
        console.error(`could not start ${handoff.argv[0]}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await tui.afterHandoff()
    }
  } finally {
    tui.close()
  }

  return EXIT.ok
}

/** One run of the screen: from the terminal taken to the terminal restored. */
async function runApp(tui: Tui): Promise<void> {
  // `q` is not a quit key to the app: inside the host-key prompt it has to
  // reach the Tui first, which is the only thing that knows a dialog is up.
  // Ctrl+C stays with the app so the terminal is restored however it dies.
  const app = await createApp({ quitKeys: ['ctrl+c'], collapseBorders: true, title: 'DiskPush' })
  tui.attach(app)

  app.on('key', (event) => {
    void (async () => {
      if (!(await tui.onKey(event))) app.quit()
      else app.invalidate()
    })()
  })
  // The frame's own regions have already had the event by the time this
  // runs; what is left is noticing the pointer leave the rows.
  app.on('mouse', (event) => tui.onMouse(event))

  app.render(({ ui, theme, width, height }) => {
    tui.view(ui, theme, width, height)
  })

  await app.start()
}
