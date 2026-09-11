/**
 * Renders the boot animation to media/boot.gif and media/boot.mp4. Frames come from a headless
 * browser (Didone hairlines need a real text engine), driven one frame at a time through
 * `renderAt(t)` in boot.html since a CSS animation would advance by wall clock between screenshots.
 *
 *   node scripts/boot-animation/render.mjs
 *   node scripts/boot-animation/render.mjs --t2='PRO–HOMELAB SPEC'
 */
import { chromium } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import process from 'node:process'

const run = promisify(execFile)
const HERE = import.meta.dirname
const ROOT = resolve(HERE, '../..')
const OUT = resolve(ROOT, 'media')
const FRAMES = resolve(ROOT, 'media/.frames')

const FPS = 25
const WIDTH = 640
const HEIGHT = 480

const options = Object.fromEntries(
  process.argv.slice(2).flatMap((arg) => {
    const match = /^--([a-z0-9]+)=(.*)$/i.exec(arg)
    return match === null ? [] : [[match[1], match[2]]]
  }),
)
const query = new URLSearchParams(options).toString()

await rm(FRAMES, { recursive: true, force: true })
await mkdir(FRAMES, { recursive: true })

const browser = await chromium.launch()
// 2x, then downsampled: the hairlines of a Didone alias badly at 1x and the mark looks broken.
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
})
await page.goto(`file://${resolve(HERE, 'boot.html')}${query ? `?${query}` : ''}`)
// The fit-to-width pass runs on load and needs the fonts to have arrived first.
await page.waitForTimeout(400)

// The page owns the timeline (`--hold=` and friends change its length), so ask it.
const DURATION = await page.evaluate(() => window.DURATION)
const total = Math.round(DURATION * FPS)
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.renderAt(t), i / FPS)
  await page.screenshot({ path: `${FRAMES}/f${String(i).padStart(4, '0')}.png` })
}
await browser.close()
console.log(`rendered ${total} frames`)

const scale = `scale=${WIDTH}:${HEIGHT}:flags=lanczos`

// One 256-colour palette for the whole clip, no dithering: fewer colours cannot represent the
// grey ramp that hides the mirrored mark, dithering a flat field is visible noise, and per-frame
// palettes make the Didone hairlines crawl.
await run('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-framerate',
  String(FPS),
  '-i',
  `${FRAMES}/f%04d.png`,
  '-vf',
  `${scale},palettegen=max_colors=256:stats_mode=full`,
  `${FRAMES}/palette.png`,
])

await run('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-framerate',
  String(FPS),
  '-i',
  `${FRAMES}/f%04d.png`,
  '-i',
  `${FRAMES}/palette.png`,
  '-lavfi',
  `${scale}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`,
  '-loop',
  '0',
  `${OUT}/boot.gif`,
])

await run('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-framerate',
  String(FPS),
  '-i',
  `${FRAMES}/f%04d.png`,
  '-vf',
  scale,
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-crf',
  '20',
  '-movflags',
  '+faststart',
  `${OUT}/boot.mp4`,
])

await rm(FRAMES, { recursive: true, force: true })
console.log(`wrote ${OUT}/boot.gif and ${OUT}/boot.mp4`)
