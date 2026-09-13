import { describe, expect, it } from 'vitest'
import type { Connection } from '@diskpush/schemas'
import { editLaunch, editorArgv, hasDesktop, mediaKind, openLaunch, type Target } from './launch.js'

const has = (...bins: string[]) => (bin: string) => bins.includes(bin)
const local = (name: string): Target => ({ path: `/home/me/${name}`, name, connection: null })
const prod: Connection = {
  id: 'prod',
  name: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  authType: 'agent',
  keyPath: null,
  jumpHost: null,
} as Connection

describe('the editor', () => {
  it('is $VISUAL, then $EDITOR, then whatever is installed', () => {
    expect(editorArgv({ VISUAL: 'code -w', EDITOR: 'nano' }, has('vim'))).toEqual(['code', '-w'])
    expect(editorArgv({ EDITOR: 'nano' }, has('vim'))).toEqual(['nano'])
    expect(editorArgv({}, has('nano', 'vi'))).toEqual(['nano'])
    expect(editorArgv({}, has())).toBeNull()
  })

  it('opens a local file in it, from its own directory', () => {
    expect(editLaunch(local('notes.md'), { EDITOR: 'vim' }, has())).toEqual({
      argv: ['vim', '/home/me/notes.md'],
      cwd: '/home/me',
      title: 'notes.md',
    })
    expect(editLaunch(local('notes.md'), {}, has())).toEqual({ error: 'No editor: set $EDITOR, or install vim or nano.' })
  })

  it('edits a remote file on the server, over ssh -t, with the editor the server has', () => {
    const target: Target = { path: '/srv/app/config.yml', name: 'config.yml', connection: prod }
    expect(editLaunch(target, { EDITOR: 'vim' }, has())).toEqual({
      argv: ['ssh', '-t', 'deploy@prod.example', '${VISUAL:-${EDITOR:-vi}} /srv/app/config.yml'],
      title: 'config.yml',
    })
    const odd: Target = {
      path: "/srv/app/it's here.yml",
      name: "it's here.yml",
      connection: { ...prod, port: 2222, keyPath: '/home/me/.ssh/prod', jumpHost: 'bastion' },
    }
    expect(editLaunch(odd, {}, has()).argv).toEqual([
      'ssh',
      '-t',
      '-p',
      '2222',
      '-i',
      '/home/me/.ssh/prod',
      '-J',
      'bastion',
      'deploy@prod.example',
      "${VISUAL:-${EDITOR:-vi}} '/srv/app/it'\\''s here.yml'",
    ])
  })
})

describe('opening with the system', () => {
  it('knows a video, a song and a picture by name', () => {
    expect(mediaKind('talk.MP4')).toBe('video')
    expect(mediaKind('song.flac')).toBe('audio')
    expect(mediaKind('photo.jpeg')).toBe('image')
    expect(mediaKind('archive.tar.gz')).toBe('other')
  })

  it('hands everything to the desktop opener when there is a desktop', () => {
    expect(hasDesktop({ DISPLAY: ':0' }, 'linux')).toBe(true)
    expect(hasDesktop({}, 'linux')).toBe(false)
    expect(hasDesktop({}, 'darwin')).toBe(true)
    expect(openLaunch(local('report.pdf'), { DISPLAY: ':0' }, has('xdg-open', 'mpv'), 'linux')).toEqual({
      argv: ['xdg-open', '/home/me/report.pdf'],
      title: 'report.pdf',
      detached: true,
    })
    expect(openLaunch(local('talk.mp4'), {}, has('open'), 'darwin')).toMatchObject({ argv: ['open', '/home/me/talk.mp4'] })
  })

  it('finds a terminal player or viewer when there is no desktop, in order of preference', () => {
    expect(openLaunch(local('talk.mp4'), {}, has('ffplay', 'mpv'), 'linux')).toMatchObject({ argv: ['mpv', '/home/me/talk.mp4'] })
    expect(openLaunch(local('talk.mp4'), {}, has('ffplay'), 'linux')).toMatchObject({ argv: ['ffplay', '/home/me/talk.mp4'] })
    // ffplay would open a window it cannot have: sound only.
    expect(openLaunch(local('song.mp3'), {}, has('ffplay'), 'linux')).toMatchObject({
      argv: ['ffplay', '-nodisp', '-autoexit', '/home/me/song.mp3'],
    })
    expect(openLaunch(local('photo.png'), {}, has('chafa'), 'linux')).toMatchObject({ argv: ['chafa', '/home/me/photo.png'], cwd: '/home/me' })
  })

  it('trusts the bytes over the name: a text file is never sent to a player', () => {
    expect(openLaunch(local('code.ts'), {}, has('ffplay'), 'linux', { text: true })).toEqual({
      error: 'code.ts is a text file: v views it, e edits it.',
    })
    // The desktop still gets it, because the desktop reads the bytes too.
    expect(openLaunch(local('code.ts'), { DISPLAY: ':0' }, has('xdg-open'), 'linux', { text: true })).toMatchObject({
      argv: ['xdg-open', '/home/me/code.ts'],
    })
  })

  it('says what is missing, and what would work instead', () => {
    expect(openLaunch(local('talk.mp4'), {}, has(), 'linux')).toEqual({ error: 'No video player found: install mpv or ffplay.' })
    expect(openLaunch(local('photo.png'), {}, has(), 'linux')).toEqual({ error: 'No image viewer found: install chafa or timg.' })
    expect(openLaunch(local('data.bin'), {}, has('mpv'), 'linux')).toEqual({
      error: 'Nothing here opens data.bin. Press e to open it in $EDITOR.',
    })
    expect(openLaunch({ path: '/srv/a.mp4', name: 'a.mp4', connection: prod }, { DISPLAY: ':0' }, has('xdg-open'), 'linux')).toEqual({
      error: 'x opens files on this machine. Sync a.mp4 here first, or press e to edit it over ssh.',
    })
  })
})
