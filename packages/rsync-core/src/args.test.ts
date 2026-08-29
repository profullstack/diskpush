import { defaultRsyncOptions } from '@diskpush/schemas'
import { describe, expect, it } from 'vitest'
import { buildRsyncArgs, renderCommand, RsyncArgError } from './args.js'
import { parseEndpoint } from './endpoint.js'
import { parseRsyncCapabilities, unknownCapabilities } from './version.js'

const MODERN = parseRsyncCapabilities(`rsync  version 3.4.1  protocol version 32
Capabilities: ACLs, xattrs, hardlinks
Compress list:
    zstd zlibx zlib none`)

const OLD = parseRsyncCapabilities(`rsync  version 3.1.6  protocol version 31
Capabilities: ACLs, xattrs, hardlinks
Compress list:
    zlib none`)

const local = (p: string) => parseEndpoint(p)

function build(over: Partial<Parameters<typeof buildRsyncArgs>[0]> = {}) {
  return buildRsyncArgs({
    source: local('./dist/'),
    destination: local('/srv/app/'),
    options: defaultRsyncOptions(),
    capabilities: MODERN,
    ...over,
  })
}

describe('default preset', () => {
  it('produces the documented DiskPush baseline', () => {
    const { args } = build()
    expect(args).toEqual([
      '--archive',
      '--partial-dir=.rsync-partial',
      '--human-readable',
      '--itemize-changes',
      '--info=progress2',
      './dist/',
      '/srv/app/',
    ])
  })

  it('never adds a delete flag by default', () => {
    const { args } = build()
    expect(args.some((a) => a.startsWith('--delete'))).toBe(false)
  })

  it('falls back to --partial when no partial directory is set', () => {
    const { args } = build({ options: defaultRsyncOptions({ partialDir: null }) })
    expect(args).toContain('--partial')
    expect(args.some((a) => a.startsWith('--partial-dir'))).toBe(false)
  })

  it('recurses even when archive is switched off', () => {
    const { args } = build({ options: defaultRsyncOptions({ archive: false }) })
    expect(args).toContain('--recursive')
    expect(args).not.toContain('--archive')
  })
})

describe('remote transport', () => {
  it('attaches the SSH transport and shields remote args on older rsync', () => {
    const { args } = build({
      destination: local('prod:/srv/app/'),
      capabilities: OLD,
      remoteShell: ['ssh', '-p', '2222', '-o', 'BatchMode=yes'],
    })
    expect(args).toContain('--rsh')
    expect(args[args.indexOf('--rsh') + 1]).toBe('ssh -p 2222 -o BatchMode=yes')
    expect(args).toContain('--protect-args')
  })

  it('omits --protect-args when both ends already default to it', () => {
    const { args } = build({
      destination: local('prod:/srv/app/'),
      capabilities: MODERN,
      remoteShell: ['ssh'],
    })
    expect(args).not.toContain('--protect-args')
  })

  it('warns loudly when the remote rsync is too old to protect args at all', () => {
    const ancient = parseRsyncCapabilities('rsync  version 2.6.9  protocol version 29')
    const { args, warnings } = build({
      destination: local('prod:/srv/app/'),
      capabilities: ancient,
      remoteShell: ['ssh'],
    })
    expect(args).not.toContain('--protect-args')
    expect(warnings.join(' ')).toMatch(/cannot shield remote paths/i)
  })

  it('asks for protection when the version could not be determined', () => {
    const { args } = build({
      destination: local('prod:/srv/app/'),
      capabilities: unknownCapabilities(),
      remoteShell: ['ssh'],
    })
    expect(args).toContain('--protect-args')
  })

  it('refuses to build a remote job with no transport configured', () => {
    expect(() => build({ destination: local('prod:/srv/app/') })).toThrow(/no SSH transport/i)
  })

  it('refuses two remote endpoints in one invocation', () => {
    expect(() => build({ source: local('a:/x/'), destination: local('b:/y/') })).toThrow(
      /cannot have two remote endpoints/i,
    )
  })
})

describe('mirror safety', () => {
  it('refuses to build a live delete job that has not been confirmed', () => {
    expect(() => build({ options: defaultRsyncOptions({ deleteMode: 'delay' }) })).toThrow(RsyncArgError)
  })

  it('allows the dry run that produces the delete preview', () => {
    const { args } = build({ options: defaultRsyncOptions({ deleteMode: 'delay', dryRun: true }) })
    expect(args).toContain('--delete-delay')
    expect(args).toContain('--dry-run')
  })

  it('allows a live mirror once the delete list has been confirmed', () => {
    const { args } = build({ options: defaultRsyncOptions({ deleteMode: 'delay' }), deletesConfirmed: true })
    expect(args).toContain('--delete-delay')
    expect(args).not.toContain('--dry-run')
  })
})

describe('raw pass-through arguments', () => {
  it('appends verbatim tokens after the generated flags', () => {
    const { args } = build({ options: defaultRsyncOptions({ rawArgs: ['-aHAX', '--checksum'] }) })
    expect(args.slice(-4)).toEqual(['-aHAX', '--checksum', './dist/', '/srv/app/'])
  })

  it('never splits or re-quotes a token', () => {
    const { args } = build({ options: defaultRsyncOptions({ rawArgs: ['--exclude=a b/c;d $(x)'] }) })
    expect(args).toContain('--exclude=a b/c;d $(x)')
  })

  it('blocks --delete smuggled in after the separator', () => {
    expect(() => build({ options: defaultRsyncOptions({ rawArgs: ['--delete'] }) })).toThrow(/Mirror mode/i)
  })

  it('blocks --delete hidden in a bundled short flag list', () => {
    expect(() => build({ options: defaultRsyncOptions({ rawArgs: ['--delete-during'] }) })).toThrow(/Mirror mode/i)
  })

  it('blocks --remove-source-files, which deletes the source', () => {
    expect(() => build({ options: defaultRsyncOptions({ rawArgs: ['--remove-source-files'] }) })).toThrow(
      /deletes files from the source/i,
    )
  })

  it('still blocks --remove-source-files even when a mirror was confirmed', () => {
    // Confirming a destination delete list says nothing about deleting the
    // source, so the waiver must not extend to it.
    expect(() =>
      build({
        options: defaultRsyncOptions({ deleteMode: 'delay', rawArgs: ['--delete', '--remove-source-files'] }),
        deletesConfirmed: true,
      }),
    ).toThrow(/deletes files from the source/i)
  })

  it('permits a raw delete flag once mirror mode is on and confirmed', () => {
    const { args } = build({
      options: defaultRsyncOptions({ deleteMode: 'delay', rawArgs: ['--delete-excluded'] }),
      deletesConfirmed: true,
    })
    expect(args).toContain('--delete-excluded')
  })

  it('warns when raw args would hijack the transport', () => {
    const { warnings } = build({
      destination: local('prod:/srv/app/'),
      remoteShell: ['ssh'],
      options: defaultRsyncOptions({ rawArgs: ['--rsh=ssh -p 9999'] }),
    })
    expect(warnings.join(' ')).toMatch(/replaces the SSH transport/i)
  })
})

describe('capability gating', () => {
  it('downgrades zstd to zlib when one end lacks it', () => {
    const { args, warnings } = build({ options: defaultRsyncOptions({ compression: 'zstd' }), capabilities: OLD })
    expect(args).toContain('--compress')
    expect(args).not.toContain('--compress-choice=zstd')
    expect(warnings.join(' ')).toMatch(/downgraded to zlib/i)
  })

  it('keeps zstd when both ends support it', () => {
    const { args } = build({ options: defaultRsyncOptions({ compression: 'zstd' }) })
    expect(args).toContain('--compress-choice=zstd')
  })

  it('adds no compression flag on auto', () => {
    const { args } = build({ options: defaultRsyncOptions({ compression: 'auto' }) })
    expect(args.some((a) => a.startsWith('--compress'))).toBe(false)
  })

  it('drops --mkpath when the remote is older than 3.2.3', () => {
    const { args, warnings } = build({ options: defaultRsyncOptions({ mkpath: true }), capabilities: OLD })
    expect(args).not.toContain('--mkpath')
    expect(warnings.join(' ')).toMatch(/mkpath/i)
  })
})

describe('filters', () => {
  it('emits includes before excludes so an include is reachable', () => {
    const { args } = build({
      options: defaultRsyncOptions({ includes: ['*.js'], excludes: ['node_modules/', '*.log'] }),
    })
    expect(args.indexOf('--include=*.js')).toBeLessThan(args.indexOf('--exclude=node_modules/'))
  })
})

describe('renderCommand', () => {
  it('quotes only what needs quoting', () => {
    expect(renderCommand(['--archive', './a b/', 'prod:/srv/'])).toBe("rsync --archive './a b/' prod:/srv/")
  })

  it('escapes embedded single quotes', () => {
    expect(renderCommand(["it's"])).toBe(`rsync 'it'\\''s'`)
  })
})
