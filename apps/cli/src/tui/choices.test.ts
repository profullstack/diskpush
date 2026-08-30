import { describe, expect, it } from 'vitest'
import { buildEndpointChoices } from './app.js'
import type { Connection } from '@diskpush/schemas'

const conn = (name: string, host: string, path: string | null = null): Connection =>
  ({
    id: name,
    name,
    host,
    port: 22,
    username: 'deploy',
    authType: 'agent',
    keyPath: null,
    defaultLocalPath: null,
    defaultRemotePath: path,
    jumpHost: null,
    rsyncPath: null,
    connectTimeoutSeconds: 15,
    keepaliveSeconds: 30,
    forwardAgent: false,
    tags: [],
    notes: '',
    createdAt: '',
    updatedAt: '',
  }) as Connection

describe('buildEndpointChoices', () => {
  it('always offers Local first, so a bare tui is not stuck on it either', () => {
    const choices = buildEndpointChoices([], [], '/home/me')
    expect(choices).toHaveLength(1)
    expect(choices[0]).toMatchObject({ label: 'Local', connection: null, path: '/home/me' })
  })

  it('lists saved connections, then ssh_config hosts', () => {
    const choices = buildEndpointChoices([conn('prod', 'a.example')], [conn('dev', 'b.example')], '/tmp')
    expect(choices.map((c) => c.label)).toEqual(['Local', 'prod', 'dev'])
    expect(choices[2]?.detail).toContain('ssh config')
  })

  it('drops an ssh_config host that a saved connection already covers', () => {
    // The saved one wins: it carries a port, a key and a default path.
    const choices = buildEndpointChoices([conn('prod', 'saved.example')], [conn('prod', 'config.example')], '/tmp')
    expect(choices.map((c) => c.label)).toEqual(['Local', 'prod'])
    expect(choices[1]?.detail).toContain('saved.example')
  })

  it('drops a repeated alias, which ~/.ssh/config really does contain', () => {
    const choices = buildEndpointChoices([], [conn('web', 'x.example'), conn('web', 'x.example')], '/tmp')
    expect(choices.map((c) => c.label)).toEqual(['Local', 'web'])
  })

  it('uses a connection default remote path when it has one', () => {
    const choices = buildEndpointChoices([conn('prod', 'a.example', '/srv/app')], [], '/tmp')
    expect(choices[1]?.path).toBe('/srv/app')
  })

  it('falls back to the remote home directory when it does not', () => {
    expect(buildEndpointChoices([conn('prod', 'a.example')], [], '/tmp')[1]?.path).toBe('.')
  })
})
