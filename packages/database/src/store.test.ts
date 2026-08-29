import { defaultRsyncOptions } from '@diskpush/schemas'
import { describe, expect, it } from 'vitest'
import { DiskPushStore } from './store.js'
import { databasePath, diskpushHome } from './paths.js'

async function store() {
  return DiskPushStore.open({ path: ':memory:' })
}

const connectionInput = {
  name: 'production',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authType: 'agent' as const,
  keyPath: null,
  defaultLocalPath: null,
  defaultRemotePath: '/srv/app',
  jumpHost: null,
  rsyncPath: null,
  connectTimeoutSeconds: 15,
  keepaliveSeconds: 30,
  forwardAgent: false,
  tags: ['web'],
  notes: '',
}

describe('paths', () => {
  it('honours DISKPUSH_HOME', () => {
    expect(diskpushHome({ DISKPUSH_HOME: '/tmp/dp' })).toBe('/tmp/dp')
    expect(databasePath({ DISKPUSH_HOME: '/tmp/dp' })).toBe('/tmp/dp/diskpush.db')
  })

  it('falls back to XDG_CONFIG_HOME', () => {
    expect(diskpushHome({ XDG_CONFIG_HOME: '/home/x/.config' })).toBe('/home/x/.config/diskpush')
  })
})

describe('connections', () => {
  it('saves and reads back a connection', async () => {
    const db = await store()
    const saved = await db.saveConnection(connectionInput)
    expect(saved.id).toBeTruthy()

    const found = await db.findConnection('production')
    expect(found).toMatchObject({ host: 'example.com', username: 'deploy', tags: ['web'] })
    await db.close()
  })

  it('updates in place when the name already exists', async () => {
    const db = await store()
    const first = await db.saveConnection(connectionInput)
    const second = await db.saveConnection({ ...connectionInput, host: 'new.example.com' })

    expect(second.id).toBe(first.id)
    expect((await db.listConnections())).toHaveLength(1)
    expect((await db.findConnection('production'))?.host).toBe('new.example.com')
    await db.close()
  })

  it('finds a connection by id as well as by name', async () => {
    const db = await store()
    const saved = await db.saveConnection(connectionInput)
    expect((await db.findConnection(saved.id))?.name).toBe('production')
    await db.close()
  })

  it('deletes', async () => {
    const db = await store()
    await db.saveConnection(connectionInput)
    expect(await db.deleteConnection('production')).toBe(true)
    expect(await db.deleteConnection('production')).toBe(false)
    await db.close()
  })

  it('stores no credential material', async () => {
    const db = await store()
    const saved = await db.saveConnection(connectionInput)
    expect(Object.keys(saved)).not.toContain('password')
    expect(Object.keys(saved)).not.toContain('passphrase')
    await db.close()
  })
})

describe('profiles', () => {
  const profileInput = {
    name: 'Production Website',
    source: { type: 'local' as const, path: '/home/anthony/site/' },
    destination: { type: 'ssh' as const, host: 'prod', path: '/var/www/site/' },
    preset: 'fast-sync' as const,
    options: defaultRsyncOptions({ excludes: ['node_modules/', '.git/'] }),
    trustDeletes: false,
    schedule: { enabled: false, kind: 'daily' as const, cron: null },
    watch: { enabled: false, debounceMs: 1000 },
    notifyOnSuccess: false,
    notifyOnFailure: true,
  }

  it('round-trips endpoints and options through JSON', async () => {
    const db = await store()
    await db.saveProfile(profileInput)
    const found = await db.findProfile('Production Website')

    expect(found?.source).toEqual({ type: 'local', path: '/home/anthony/site/' })
    expect(found?.destination).toEqual({ type: 'ssh', host: 'prod', path: '/var/www/site/' })
    expect(found?.options.excludes).toEqual(['node_modules/', '.git/'])
    await db.close()
  })

  it('defaults trustDeletes to off so a saved mirror still asks', async () => {
    const db = await store()
    await db.saveProfile(profileInput)
    expect((await db.findProfile('Production Website'))?.trustDeletes).toBe(false)
    await db.close()
  })
})

describe('jobs', () => {
  it('records a job and its state transitions', async () => {
    const db = await store()
    const job = await db.createJob({
      id: 'job-1',
      profileId: null,
      source: { type: 'local', path: './a/' },
      destination: { type: 'ssh', host: 'prod', path: '/b/' },
      options: defaultRsyncOptions(),
      state: 'queued',
      bytesTotal: 0,
      bytesTransferred: 0,
      percent: 0,
      filesTransferred: 0,
      retryCount: 0,
      exitCode: null,
      errorSummary: null,
      logPath: null,
      startedAt: null,
      completedAt: null,
    })
    expect(job.state).toBe('queued')

    await db.updateJob('job-1', { state: 'running', percent: 42, bytesTransferred: 1024 })
    expect(await db.findJob('job-1')).toMatchObject({ state: 'running', percent: 42, bytesTransferred: 1024 })

    await db.updateJob('job-1', { state: 'interrupted', exitCode: 20 })
    const listed = await db.listJobs(10, 'interrupted')
    expect(listed.map((j) => j.id)).toEqual(['job-1'])
    await db.close()
  })

  it('appends events for the diagnostics view', async () => {
    const db = await store()
    await db.createJob({
      id: 'job-2',
      profileId: null,
      source: { type: 'local', path: './a/' },
      destination: { type: 'local', path: './b/' },
      options: defaultRsyncOptions(),
      state: 'queued',
      bytesTotal: 0,
      bytesTransferred: 0,
      percent: 0,
      filesTransferred: 0,
      retryCount: 0,
      exitCode: null,
      errorSummary: null,
      logPath: null,
      startedAt: null,
      completedAt: null,
    })
    await expect(db.appendEvent('job-2', 'stderr', 'something went wrong')).resolves.toBeUndefined()
    await db.close()
  })
})

describe('settings', () => {
  it('stores and reads JSON values with a fallback', async () => {
    const db = await store()
    expect(await db.getSetting('concurrency', 1)).toBe(1)
    await db.setSetting('concurrency', 4)
    expect(await db.getSetting('concurrency', 1)).toBe(4)
    await db.close()
  })
})

describe('migrations', () => {
  it('are idempotent across reopens', async () => {
    const db = await store()
    await expect(DiskPushStore.open({ path: ':memory:' })).resolves.toBeTruthy()
    await db.close()
  })
})
