import { describe, expect, it } from 'vitest'
import { DiskPushStore } from './store.js'

async function store() {
  return DiskPushStore.open({ path: ':memory:' })
}

const commandInput = {
  name: 'reload-nginx',
  description: 'Reload nginx config',
  script: 'systemctl reload nginx',
  interpreter: 'sh' as const,
  sudo: true,
  workingDirectory: null,
  timeoutSeconds: 60,
  targets: ['tag:web'],
  tags: [],
}

const builtin = {
  id: 'builtin:uptime',
  name: 'uptime',
  description: 'Load average',
  script: 'uptime',
  interpreter: 'raw' as const,
  sudo: false,
  workingDirectory: null,
  timeoutSeconds: 30,
  targets: [],
  tags: [],
  builtin: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

describe('fleet commands', () => {
  it('saves a command and reads it back', async () => {
    const db = await store()
    const saved = await db.saveFleetCommand(commandInput)

    expect(saved.builtin).toBe(false)
    const found = await db.findFleetCommand('reload-nginx')
    expect(found?.script).toBe('systemctl reload nginx')
    expect(found?.targets).toEqual(['tag:web'])
    expect(found?.sudo).toBe(true)
  })

  it('updates in place rather than creating a second command with the same name', async () => {
    const db = await store()
    const first = await db.saveFleetCommand({ ...commandInput, name: 'deploy', script: 'echo one' })
    const second = await db.saveFleetCommand({ ...commandInput, name: 'deploy', script: 'echo two' })

    expect(second.id).toBe(first.id)
    expect((await db.listFleetCommands()).filter((command) => command.name === 'deploy')).toHaveLength(1)
  })

  it('lists built-ins alongside saved commands without storing them', async () => {
    const db = await store()
    expect(await db.listFleetCommands([builtin])).toHaveLength(1)
    // Deliberately not seeded: with no built-in supplied there is nothing in
    // the table, so upgrading DiskPush cannot leave stale copies behind.
    expect(await db.listFleetCommands()).toHaveLength(0)
  })

  it('lets a saved command of the same name shadow a built-in', async () => {
    const db = await store()
    await db.saveFleetCommand({ ...commandInput, name: 'uptime', script: 'uptime -p' })

    const listed = await db.listFleetCommands([builtin])
    expect(listed).toHaveLength(1)
    expect(listed[0]?.script).toBe('uptime -p')
    expect((await db.findFleetCommand('uptime', [builtin]))?.script).toBe('uptime -p')
  })

  it('never marks a stored command as built-in, whatever it was copied from', async () => {
    const db = await store()
    const saved = await db.saveFleetCommand({ ...commandInput, name: 'copy-of-uptime' })
    expect(saved.builtin).toBe(false)
    expect((await db.findFleetCommand('copy-of-uptime'))?.builtin).toBe(false)
  })

  it('removes a saved command', async () => {
    const db = await store()
    await db.saveFleetCommand(commandInput)
    expect(await db.deleteFleetCommand('reload-nginx')).toBe(true)
    expect(await db.findFleetCommand('reload-nginx')).toBeNull()
  })
})

describe('fleet runs', () => {
  const runInput = {
    id: 'run-1',
    commandId: null,
    label: 'systemctl reload nginx',
    script: 'systemctl reload nginx',
    interpreter: 'raw' as const,
    sudo: true,
    workingDirectory: null,
    timeoutSeconds: 60,
    concurrency: 4,
    onFailure: 'continue' as const,
    targetSelector: ['tag:web'],
    state: 'running' as const,
    hostsTotal: 2,
    hostsSucceeded: 0,
    hostsFailed: 0,
    completedAt: null,
  }

  const hostResult = {
    runId: 'run-1',
    connectionId: 'c1',
    connectionName: 'web-01',
    host: 'web-01.example.com',
    state: 'succeeded' as const,
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    errorSummary: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
  }

  it('records a run and its per-host results', async () => {
    const db = await store()
    await db.createFleetRun(runInput)
    await db.saveFleetHostResult(hostResult)
    await db.completeFleetRun('run-1', { state: 'completed', hostsSucceeded: 1, hostsFailed: 0 })

    const run = await db.findFleetRun('run-1')
    expect(run?.state).toBe('completed')
    expect(run?.hostsSucceeded).toBe(1)
    expect(run?.completedAt).not.toBeNull()

    const hosts = await db.listFleetRunHosts('run-1')
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.stdout).toBe('ok\n')
  })

  it('keeps the script it ran, so editing the saved command cannot rewrite history', async () => {
    const db = await store()
    const command = await db.saveFleetCommand({ ...commandInput, name: 'deploy', script: 'echo original' })
    await db.createFleetRun({ ...runInput, commandId: command.id, script: 'echo original' })
    await db.saveFleetCommand({ ...commandInput, id: command.id, name: 'deploy', script: 'echo rewritten' })

    expect((await db.findFleetRun('run-1'))?.script).toBe('echo original')
  })

  it('keeps the server name it ran on, so a rename does not erase the record', async () => {
    const db = await store()
    await db.createFleetRun(runInput)
    await db.saveFleetHostResult(hostResult)
    // Nothing joins back to `connections`: the name and host are copies.
    expect((await db.listFleetRunHosts('run-1'))[0]?.connectionName).toBe('web-01')
  })

  it('finds a run by the short id a summary prints', async () => {
    const db = await store()
    await db.createFleetRun({ ...runInput, id: 'abcdef12-3456-7890-abcd-ef1234567890' })
    expect((await db.findFleetRun('abcdef12'))?.id).toBe('abcdef12-3456-7890-abcd-ef1234567890')
  })

  it('upserts a host result rather than duplicating it', async () => {
    const db = await store()
    await db.createFleetRun(runInput)
    await db.saveFleetHostResult({ ...hostResult, state: 'running', exitCode: null })
    await db.saveFleetHostResult(hostResult)

    const hosts = await db.listFleetRunHosts('run-1')
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.state).toBe('succeeded')
  })

  it('lists runs newest first', async () => {
    const db = await store()
    await db.createFleetRun({ ...runInput, id: 'a', createdAt: '2026-01-01T00:00:00.000Z' })
    await db.createFleetRun({ ...runInput, id: 'b', createdAt: '2026-01-02T00:00:00.000Z' })
    expect((await db.listFleetRuns()).map((run) => run.id)).toEqual(['b', 'a'])
  })

  it('has no run for an id that was never recorded', async () => {
    expect(await (await store()).findFleetRun('nope')).toBeNull()
  })
})
