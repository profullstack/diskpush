/**
 * Which files are media, and how each is sent.
 *
 * A photo goes up as its original bytes: the server re-encodes to 768px and
 * strips EXIF itself, so there is no image library here (and so no native
 * addon for the desktop bundle to carry). A video goes up as one JPEG contact
 * sheet of nine frames, which needs ffmpeg; without it videos are skipped and
 * the run says so.
 */
import { execFile, spawn } from 'node:child_process'
import { extname } from 'node:path'

export const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'bmp', 'tif', 'tiff'])
export const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'])

export type MediaKind = 'photo' | 'video'

/** The server's per-file ceiling. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

export function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase()
}

export function mediaKind(name: string): MediaKind | null {
  const extension = extensionOf(name)
  if (PHOTO_EXTENSIONS.has(extension)) return 'photo'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return null
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export function mimeType(name: string): string {
  return MIME[extensionOf(name)] ?? 'application/octet-stream'
}

/** Runs a program to completion and returns stdout as bytes. */
function capture(command: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`${command} exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`))
    })
  })
}

export type Ffmpeg = {
  /** Seconds, from ffprobe. */
  duration(path: string, signal?: AbortSignal): Promise<number>
  /** A 3×3 JPEG contact sheet of the whole video. */
  contactSheet(path: string, duration: number, signal?: AbortSignal): Promise<Buffer>
}

/** ffmpeg and ffprobe from PATH, or null when either is missing. */
export async function findFfmpeg(): Promise<Ffmpeg | null> {
  const present = (command: string) =>
    new Promise<boolean>((resolve) => {
      execFile(command, ['-version'], (error) => resolve(!error))
    })
  if (!(await present('ffmpeg')) || !(await present('ffprobe'))) return null
  return {
    async duration(path, signal) {
      const out = await capture(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
        signal,
      )
      const seconds = Number.parseFloat(out.toString().trim())
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe could not read a duration')
      return seconds
    },
    contactSheet(path, duration, signal) {
      // Nine frames spread over the whole video, tiled 3×3 at 256px wide.
      const fps = `fps=9/${Math.max(duration, 0.1).toFixed(3)},scale=256:-2,tile=3x3`
      return capture(
        'ffmpeg',
        ['-v', 'error', '-i', path, '-vf', fps, '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'],
        signal,
      )
    },
  }
}
