import { describe, expect, it } from 'vitest'
import { ArgvError, flagValue, flagValues, hasFlag, numberFlag, parseArgv } from './parse-argv.js'

describe('the -- boundary', () => {
  it('splits DiskPush options from rsync arguments', () => {
    const parsed = parseArgv(['sync', './a/', 'prod:/b/', '--dry-run', '--', '-aHAX', '--checksum'])
    expect(parsed.command).toBe('sync')
    expect(parsed.positionals).toEqual(['./a/', 'prod:/b/'])
    expect(hasFlag(parsed, '--dry-run')).toBe(true)
    expect(parsed.rawArgs).toEqual(['-aHAX', '--checksum'])
  })

  it('passes rsync arguments through completely untouched', () => {
    const raw = ['--exclude=a b/c', '--info=progress2', "--rsync-path=sudo rsync", '$(whoami)', '']
    const parsed = parseArgv(['sync', './a/', './b/', '--', ...raw])
    expect(parsed.rawArgs).toEqual(raw)
  })

  it('does not treat a later -- as another boundary', () => {
    const parsed = parseArgv(['sync', './a/', './b/', '--', '--exclude=x', '--', '--exclude=y'])
    expect(parsed.rawArgs).toEqual(['--exclude=x', '--', '--exclude=y'])
  })

  it('records a separator with nothing after it', () => {
    const parsed = parseArgv(['sync', './a/', './b/', '--'])
    expect(parsed.hasSeparator).toBe(true)
    expect(parsed.rawArgs).toEqual([])
  })

  it('never reads DiskPush flags out of the rsync section', () => {
    const parsed = parseArgv(['sync', './a/', './b/', '--', '--json', '--dry-run'])
    expect(hasFlag(parsed, '--json')).toBe(false)
    expect(hasFlag(parsed, '--dry-run')).toBe(false)
    expect(parsed.rawArgs).toEqual(['--json', '--dry-run'])
  })

  it('does not take positionals from the rsync section', () => {
    const parsed = parseArgv(['sync', './a/', './b/', '--', 'not-an-endpoint'])
    expect(parsed.positionals).toEqual(['./a/', './b/'])
  })
})

describe('flags', () => {
  it('reads --flag value', () => {
    expect(flagValue(parseArgv(['sync', '--bwlimit', '50M']), '--bwlimit')).toBe('50M')
  })

  it('reads --flag=value, keeping spaces in the value', () => {
    const parsed = parseArgv(['sync', '--exclude=my dir/'])
    expect(flagValues(parsed, '--exclude')).toEqual(['my dir/'])
  })

  it('collects a repeatable flag', () => {
    const parsed = parseArgv(['sync', '--exclude', 'node_modules/', '--exclude', '*.log'])
    expect(flagValues(parsed, '--exclude')).toEqual(['node_modules/', '*.log'])
  })

  it('expands short aliases', () => {
    const parsed = parseArgv(['sync', '-n', '-q', '-y'])
    expect(hasFlag(parsed, '--dry-run')).toBe(true)
    expect(hasFlag(parsed, '--quiet')).toBe(true)
    expect(hasFlag(parsed, '--yes')).toBe(true)
  })

  it('complains when a value flag has no value', () => {
    expect(() => parseArgv(['sync', './a/', './b/', '--bwlimit'])).toThrow(ArgvError)
  })

  it('rejects a non-numeric value where a number is required', () => {
    expect(() => numberFlag(parseArgv(['jobs', '--limit', 'lots']), '--limit')).toThrow(ArgvError)
  })

  it('does not let an optional-value flag swallow the next endpoint', () => {
    const parsed = parseArgv(['sync', '--compress', './a/', './b/'])
    expect(parsed.positionals).toEqual(['./a/', './b/'])
    expect(hasFlag(parsed, '--compress')).toBe(true)
  })

  it('treats a bare - as a positional, not a flag', () => {
    expect(parseArgv(['sync', '-', './b/']).positionals).toEqual(['-', './b/'])
  })
})

describe('commands', () => {
  it('recognises a leading command word', () => {
    expect(parseArgv(['mirror', './a/', './b/']).command).toBe('mirror')
  })

  it('leaves the bare two-endpoint form without a command', () => {
    const parsed = parseArgv(['./dist/', 'prod:/srv/app/'])
    expect(parsed.command).toBeNull()
    expect(parsed.positionals).toEqual(['./dist/', 'prod:/srv/app/'])
  })

  it('does not mistake a path that looks like a command word', () => {
    // `sync` here is the command; the endpoint that follows keeps its place.
    const parsed = parseArgv(['sync', 'sync', './b/'])
    expect(parsed.command).toBe('sync')
    expect(parsed.positionals).toEqual(['sync', './b/'])
  })
})
