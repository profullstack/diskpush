// The host-key prompt owns the keyboard while it is up, which is right — a
// fingerprint should not be dismissable by mashing keys. What made that
// dangerous is that it could outlive the connection that asked.
//
// Reached without doing anything unusual: point a pane at a host DiskPush has
// not seen, then take fifteen seconds to compare the fingerprint. ssh2's
// readyTimeout fires, connect rejects with "Timed out while waiting for
// handshake", the pane shows that error -- and the question stays on screen
// with nobody behind it. Every key then goes to a `decide` whose promise no one
// awaits: arrows do nothing, and because the branch only ever returned true,
// `q` did not quit either. The app is frozen and the only way out is Ctrl-C.
//
// Found by driving the real TUI over a pty against a real sshd and watching it
// stop responding after a sync to a remote endpoint.
import { describe, expect, it, vi } from 'vitest'

type HostKeyDetails = { host: string; fingerprint: string; keyType: string }
type ConnectOptions = { onUnknownHostKey: (d: HostKeyDetails) => Promise<boolean> }

// Reassigned per test, so the mock is declared once and the behaviour varies.
let connectImpl: (connection: unknown, options: ConnectOptions) => Promise<unknown> = async () => ({})

vi.mock('@diskpush/ssh-core', () => ({
  SshSession: { connect: (c: unknown, o: ConnectOptions) => connectImpl(c, o) },
  SftpBrowser: { open: async () => ({ list: async () => [], close: () => {} }) },
}))
vi.mock('@diskpush/database', () => ({ knownHostsPath: () => '/tmp/known_hosts.test' }))

const { Tui, blankPane } = await import('./app.js')
type Tui = InstanceType<typeof Tui>

/** A Tui with its private host-key prompt set, as a failed connect would leave it. */
function tuiWithPrompt(onDecide: (trust: boolean) => void = () => {}) {
  const tui = new Tui(blankPane('Local', '/tmp/a'), blankPane('Local', '/tmp/b'))
  // Writing to stdout during a test would scribble on the reporter.
  ;(tui as unknown as { render: () => void }).render = () => {}
  ;(tui as unknown as { hostKey: unknown }).hostKey = {
    host: 'example.test',
    fingerprint: 'SHA256:abc',
    keyType: 'ssh-ed25519',
    decide: onDecide,
  }
  return tui
}

const prompt = (tui: InstanceType<typeof Tui>) => (tui as unknown as { hostKey: unknown }).hostKey

describe('the host-key prompt', () => {
  it('lets q quit rather than trapping the app', async () => {
    const tui = tuiWithPrompt()
    // false means "stop the app" to the caller in commands/tui.ts.
    await expect(tui.onKey({ char: 'q' })).resolves.toBe(false)
  })

  it('still answers y and n, and keeps swallowing everything else', async () => {
    const answers: boolean[] = []
    const yes = tuiWithPrompt((trust) => answers.push(trust))
    await expect(yes.onKey({ char: 'y' })).resolves.toBe(true)
    expect(answers).toEqual([true])

    const no = tuiWithPrompt((trust) => answers.push(trust))
    await expect(no.onKey({ char: 'n' })).resolves.toBe(true)
    expect(answers).toEqual([true, false])

    const esc = tuiWithPrompt((trust) => answers.push(trust))
    await expect(esc.onKey('escape')).resolves.toBe(true)
    expect(answers).toEqual([true, false, false])

    // An arrow must not leak past the prompt into the file panes behind it.
    const other = tuiWithPrompt((trust) => answers.push(trust))
    await expect(other.onKey('down')).resolves.toBe(true)
    await expect(other.onKey('tab')).resolves.toBe(true)
    expect(answers).toEqual([true, false, false])
    expect(prompt(other)).not.toBeNull()
  })

  it('is cleared when the connect that raised it fails', async () => {
    // The real session() path, with only the network stubbed: connect raises
    // the question exactly as ssh2 would and then rejects the way readyTimeout
    // does, with nobody having answered.
    connectImpl = async (_connection, options) => {
      void options.onUnknownHostKey({
        host: 'example.test',
        fingerprint: 'SHA256:abc',
        keyType: 'ssh-ed25519',
      })
      throw new Error('Timed out while waiting for handshake')
    }

    const tui = new Tui(blankPane('Local', '/tmp/a'), blankPane('Local', '/tmp/b'))
    ;(tui as unknown as { render: () => void }).render = () => {}
    const session = (tui as unknown as {
      session: (c: unknown) => Promise<unknown>
    }).session.bind(tui)

    await expect(session({ id: 'c1', host: 'example.test' })).rejects.toThrow(
      'Timed out while waiting for handshake',
    )

    // Before the fix this was still set, and the app was unusable from here on.
    expect(prompt(tui)).toBeNull()
    // With the question gone, the keyboard comes back to the panes.
    await expect(tui.onKey({ char: 'q' })).resolves.toBe(false)
  })
})
