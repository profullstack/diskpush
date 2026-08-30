import { describe, expect, it } from 'vitest'
import { desktopEnv } from './desktop.js'

describe('desktopEnv', () => {
  it('removes ELECTRON_RUN_AS_NODE', () => {
    // A desktop install runs the CLI on the Node inside Electron, so the shim
    // sets this. Inherited by a spawn, it makes the app start as a Node
    // process and exit instead of opening a window — `diskpush desktop`
    // reports success and nothing appears.
    const env = desktopEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' })
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('leaves an ordinary environment alone', () => {
    expect(desktopEnv({ HOME: '/home/me' })).toEqual({ HOME: '/home/me' })
  })
})
