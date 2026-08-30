import { describe, expect, it } from 'vitest'
import { installerFlags, type InstallManifest } from './commands/self.js'
import { parseArgv } from './parse-argv.js'

function manifest(desktop: boolean): InstallManifest {
  return {
    version: '0.2.0',
    method: desktop ? 'linux-app' : 'cli-tarball',
    installer: 'https://diskpush.com/install.sh',
    installedAt: '2026-08-30T00:00:00Z',
    paths: [],
    desktop,
  }
}

describe('installerFlags', () => {
  it('leaves a CLI-only install to the installer to auto-detect', () => {
    // The bug this exists to prevent: pinning --cli-only meant an install made
    // from a tty could never gain the desktop app, however often it updated.
    expect(installerFlags(manifest(false))).toEqual([])
  })

  it('pins a desktop install to --desktop', () => {
    // Updating from a cron job or an SSH session has no DISPLAY to detect, so
    // auto-detect would strip the app out from under a working desktop.
    expect(installerFlags(manifest(true))).toEqual(['--desktop'])
  })

  it('honours an explicit --cli-only on a desktop install', () => {
    const parsed = parseArgv(['update', '--cli-only'])
    expect(installerFlags(manifest(true), parsed)).toEqual(['--cli-only'])
  })

  it('honours an explicit --desktop on a CLI-only install', () => {
    const parsed = parseArgv(['update', '--desktop'])
    expect(installerFlags(manifest(false), parsed)).toEqual(['--desktop'])
  })

  it('prefers --cli-only when both are somehow passed', () => {
    const parsed = parseArgv(['update', '--cli-only', '--desktop'])
    expect(installerFlags(manifest(false), parsed)).toEqual(['--cli-only'])
  })

  it('adds no flag for a plain update of a CLI-only install', () => {
    const parsed = parseArgv(['update'])
    expect(installerFlags(manifest(false), parsed)).toEqual([])
  })
})
