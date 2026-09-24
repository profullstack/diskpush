/**
 * Which files are media, and how each is sent.
 *
 * Photos, audio and documents go up as their original bytes: the server
 * converts them (a 768px preview with EXIF stripped, the first page and text
 * of a PDF or office file, the tags and cover art of a song) and deletes the
 * original, so there is no image or office library here (and no native addon
 * for the desktop bundle to carry). A video goes up as one JPEG contact sheet
 * of nine frames when ffmpeg is installed; without it, a video under 30 MB
 * goes up whole for the server to sample, and a larger one is skipped.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, sep } from 'node:path'

// Mirror of mediaanalyzer.pro's packages/convert/src/types.ts: what the server can
// read. Keep the two in step; anything listed here goes up and the server converts it.
const list = (text: string) => text.trim().split(/\s+/)

export const PHOTO_EXTENSIONS = new Set(
  list(`jpg jpeg jpe jfif png webp gif avif tif tiff svg heic heif
    bmp dib ico cur psd psb xcf tga icb vda vst pcx ppm pgm pbm pnm pam sgi rgb jp2 j2k jpf jpx jpm jxl dds exr hdr
    pict pct wbmp xbm xpm miff mng jng fits fts fit dpx cin qoi wpg cals sun ras otb palm
    dng cr2 cr3 crw nef nrw arw srf sr2 orf rw2 raf pef rwl 3fr erf kdc dcr mrw mos x3f iiq srw mef raw
    eps epsf epsi ps ai`),
)
export const VIDEO_EXTENSIONS = new Set(
  list(`mp4 m4v mov qt avi mkv webm wmv asf flv f4v mpg mpeg mpe m1v m2v m2ts mts ts vob 3gp 3g2 ogv mxf dv rm rmvb
    divx y4m h264 h265 hevc 264 265 nut ivf bik gxf roq smk yuv insv lrv dav`),
)
export const AUDIO_EXTENSIONS = new Set(
  list(`mp3 m4a m4b aac wav wave flac ogg oga opus wma aiff aif aifc alac amr awb ape mka ac3 eac3 dts au snd caf wv
    tta ra spx gsm 8svx voc mpc mp2 mpa w64 rf64 dsf dff mid midi mod s3m xm it weba 3ga`),
)
export const DOCUMENT_EXTENSIONS = new Set(
  list(`pdf
    doc docx docm dot dotx dotm odt ott fodt rtf wpd wps wri lwp abw zabw pages hwp sxw stw uot 602
    xls xlsx xlsm xlsb xlt xltx xltm ods ots fods numbers sxc stc dif slk wk1 wks 123 dbf uos
    ppt pptx pptm pps ppsx ppsm pot potx potm odp otp fodp key sxi sti uop
    odg otg fodg vsd vsdx vdx pub cdr sxd std cgm wmf emf svm
    md markdown mdown mkd mkdn mdwn mdtxt mdtext rmd qmd djot dj rst rest org tex latex ltx html htm xhtml shtml epub
    fb2 ipynb dbk docbook jats textile wiki mediawiki dokuwiki creole tikiwiki twiki vimwiki jira muse opml t2t pod man
    mdoc haddock typ bib bibtex biblatex ris enl csljson
    txt text log csv tsv json yaml yml xml srt vtt sub nfo ini conf cfg`),
)

export type MediaKind = 'photo' | 'video' | 'audio' | 'document'

/** The server's per-file ceiling. */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

export function extensionOf(name: string): string {
  return extname(name).slice(1).toLowerCase()
}

export function mediaKind(name: string): MediaKind | null {
  const extension = extensionOf(name)
  if (PHOTO_EXTENSIONS.has(extension)) return 'photo'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
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

/** What ffmpeg prints on stderr for `-i FILE` (it exits non-zero: no output was asked for). */
function probeText(command: string, path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'], ...(signal ? { signal } : {}) })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', () => resolve(err))
  })
}

/** `Duration: 01:02:03.45` from ffmpeg's banner, in seconds. */
export function parseDuration(text: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * "500MB", "2GB", "1.5g", "750" (MB) to bytes; empty means no limit. Used for
 * the opt-in "skip files larger than" limit: every size is included by default.
 */
export function parseSize(text: string | undefined | null): number | null {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return null
  const m = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb|t|tb)?$/.exec(t)
  if (!m) throw new Error(`not a size: "${text}" (try 500MB or 2GB)`)
  const unit = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }[m[2] ?? 'mb']!
  return Math.round(Number(m[1]) * unit)
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export type Ffmpeg = {
  /** Seconds, read from ffmpeg's own banner (no ffprobe needed). */
  duration(path: string, signal?: AbortSignal): Promise<number>
  /** A 3×3 JPEG contact sheet of the whole video. */
  contactSheet(path: string, duration: number, signal?: AbortSignal): Promise<Buffer>
}

/**
 * The ffmpeg that ships with DiskPush (ffmpeg-static), unless one is on PATH:
 * a system build may know more codecs. Inside the Electron app the binary sits
 * in app.asar.unpacked, because nothing inside an asar can be executed.
 */
export function bundledFfmpegPath(): string | null {
  try {
    const path = createRequire(import.meta.url)('ffmpeg-static') as string | null
    if (!path) return null
    const unpacked = path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    return existsSync(unpacked) ? unpacked : existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** ffmpeg from PATH or the bundled one, or null when there is neither. */
export async function findFfmpeg(): Promise<Ffmpeg | null> {
  const works = (command: string) =>
    new Promise<boolean>((resolve) => {
      execFile(command, ['-version'], (error) => resolve(!error))
    })
  const bundled = bundledFfmpegPath()
  const ffmpeg = (await works('ffmpeg')) ? 'ffmpeg' : bundled && (await works(bundled)) ? bundled : null
  if (!ffmpeg) return null
  return {
    async duration(path, signal) {
      const seconds = parseDuration(await probeText(ffmpeg, path, signal))
      if (seconds === null) throw new Error('ffmpeg could not read a duration')
      return seconds
    },
    contactSheet(path, duration, signal) {
      // Nine frames, each fetched by seeking straight to its point in the file,
      // so a 2 GB video takes as long as a 2 MB one: nothing in between is decoded.
      const inputs: string[] = []
      const cells: string[] = []
      for (let i = 0; i < 9; i++) {
        inputs.push('-ss', ((duration * (i + 0.5)) / 9).toFixed(2), '-i', path)
        cells.push(`[${i}:v]scale=256:144:force_original_aspect_ratio=decrease,pad=256:144:(ow-iw)/2:(oh-ih)/2,setsar=1[c${i}]`)
      }
      const grid = `${cells.join(';')};[c0][c1][c2]hstack=inputs=3[r0];[c3][c4][c5]hstack=inputs=3[r1];[c6][c7][c8]hstack=inputs=3[r2];[r0][r1][r2]vstack=inputs=3`
      return capture(
        ffmpeg,
        ['-v', 'error', ...inputs, '-filter_complex', grid, '-an', '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'],
        signal,
      )
    },
  }
}
