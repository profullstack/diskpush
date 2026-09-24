// Time the contact sheet on a real file: node scripts/time-sheet.mjs <video>
import { findFfmpeg } from '../dist/media.js'

const path = process.argv[2]
const ffmpeg = await findFfmpeg()
if (!ffmpeg) throw new Error('no ffmpeg')
let t = Date.now()
const seconds = await ffmpeg.duration(path)
console.log(`duration ${seconds.toFixed(1)}s read in ${Date.now() - t} ms`)
t = Date.now()
const sheet = await ffmpeg.contactSheet(path, seconds)
console.log(`contact sheet ${sheet.length} bytes (jpeg: ${sheet[0] === 0xff && sheet[1] === 0xd8}) in ${Date.now() - t} ms`)
