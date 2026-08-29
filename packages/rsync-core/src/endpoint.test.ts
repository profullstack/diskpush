import { describe, expect, it } from 'vitest'
import { EndpointParseError, hasTrailingSlash, parseEndpoint, renderEndpoint, sameHost, withTrailingSlash } from './endpoint.js'

describe('parseEndpoint', () => {
  it('treats absolute and relative paths as local', () => {
    expect(parseEndpoint('/var/www')).toEqual({ type: 'local', path: '/var/www' })
    expect(parseEndpoint('./dist/')).toEqual({ type: 'local', path: './dist/' })
    expect(parseEndpoint('../sibling')).toEqual({ type: 'local', path: '../sibling' })
    expect(parseEndpoint('~/media')).toEqual({ type: 'local', path: '~/media' })
    expect(parseEndpoint('.')).toEqual({ type: 'local', path: '.' })
  })

  it('treats a bare name as a local relative path', () => {
    expect(parseEndpoint('dist')).toEqual({ type: 'local', path: 'dist' })
  })

  it('parses host:path as an SSH endpoint', () => {
    expect(parseEndpoint('production:/srv/app/')).toEqual({
      type: 'ssh',
      host: 'production',
      path: '/srv/app/',
    })
  })

  it('parses user@host:path', () => {
    expect(parseEndpoint('deploy@example.com:/var/www')).toEqual({
      type: 'ssh',
      host: 'example.com',
      user: 'deploy',
      path: '/var/www',
    })
  })

  it('reads a bare host: as the remote home directory', () => {
    expect(parseEndpoint('prod:')).toEqual({ type: 'ssh', host: 'prod', path: '.' })
  })

  it('does not mistake a Windows drive letter for a host', () => {
    expect(parseEndpoint('C:\\Users\\anthony')).toEqual({ type: 'local', path: 'C:\\Users\\anthony' })
    expect(parseEndpoint('D:/data', 'win32')).toEqual({ type: 'local', path: 'D:/data' })
  })

  it('reads a one-letter hostname as a host, not a drive, off Windows', () => {
    expect(parseEndpoint('a:/srv/media/', 'linux')).toEqual({ type: 'ssh', host: 'a', path: '/srv/media/' })
  })

  it('rejects rsync daemon URLs rather than silently mishandling them', () => {
    expect(() => parseEndpoint('rsync://host/module')).toThrow(EndpointParseError)
  })

  it('rejects an empty endpoint', () => {
    expect(() => parseEndpoint('   ')).toThrow(EndpointParseError)
  })
})

describe('renderEndpoint', () => {
  it('round-trips a remote endpoint without its port', () => {
    const endpoint = parseEndpoint('deploy@example.com:/var/www')
    expect(renderEndpoint({ ...endpoint, port: 2222 } as never)).toBe('deploy@example.com:/var/www')
  })

  it('renders paths with shell metacharacters verbatim', () => {
    const endpoint = parseEndpoint('prod:/srv/$(whoami)/a b;c')
    expect(renderEndpoint(endpoint)).toBe('prod:/srv/$(whoami)/a b;c')
  })
})

describe('trailing slash handling', () => {
  it('is preserved exactly as typed', () => {
    expect(hasTrailingSlash(parseEndpoint('./dist/'))).toBe(true)
    expect(hasTrailingSlash(parseEndpoint('./dist'))).toBe(false)
  })

  it('can be added without duplicating', () => {
    expect(withTrailingSlash(parseEndpoint('./dist')).path).toBe('./dist/')
    expect(withTrailingSlash(parseEndpoint('./dist/')).path).toBe('./dist/')
  })
})

describe('sameHost', () => {
  it('detects the same server on both sides', () => {
    expect(sameHost(parseEndpoint('prod:/a'), parseEndpoint('prod:/b'))).toBe(true)
    expect(sameHost(parseEndpoint('prod:/a'), parseEndpoint('backup:/b'))).toBe(false)
    expect(sameHost(parseEndpoint('./a'), parseEndpoint('./b'))).toBe(true)
    expect(sameHost(parseEndpoint('./a'), parseEndpoint('prod:/b'))).toBe(false)
  })
})
