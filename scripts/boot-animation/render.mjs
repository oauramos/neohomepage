/**
 * Render the boot animation.
 *
 * A tribute to the Neo Geo cabinet's startup screen — the wordmark turning in from mirrored
 * through a metallic flash, the spec line wiping in beneath it, the maker's mark fading up last.
 *
 * Frames come from a headless browser rather than a canvas library for one reason: the mark is set
 * in a Didone, and Didone hairlines are where cheap rasterisers fall apart. The browser's text
 * engine renders them properly at 2x and ffmpeg downsamples with Lanczos.
 *
 * The animation is a pure function of time — `renderAt(t)` in boot.html — and this drives it one
 * frame at a time. A CSS animation would advance by wall clock between screenshots, which under
 * headless capture is uneven, and the loop seam shows it.
 *
 *   node scripts/boot-animation/render.mjs
 *   node scripts/boot-animation/render.mjs --t2='PRO–HOMELAB SPEC'
 */
import { chromium } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import process from 'node:process'

const run = promisify(execFile)
const HERE = dirname(new URL(import.meta.url).pathname)
const ROOT = resolve(HERE, '../..')
const OUT = resolve(ROOT, 'media')
const FRAMES = resolve(ROOT, 'media/.frames')

const FPS = 25
const DURATION = 7.0
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

const total = Math.round(DURATION * FPS)
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.renderAt(t), i / FPS)
  await page.screenshot({ path: `${FRAMES}/f${String(i).padStart(4, '0')}.png` })
}
await browser.close()
console.log(`rendered ${total} frames`)

const scale = `scale=${WIDTH}:${HEIGHT}:flags=lanczos`

// One palette for the whole clip. Per-frame palettes shimmer on a mark this thin — the hairlines
// get quantised differently frame to frame and the letters crawl.
await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`,
  '-vf', `${scale},palettegen=max_colors=128:stats_mode=full`, `${FRAMES}/palette.png`])

await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`,
  '-i', `${FRAMES}/palette.png`,
  '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
  '-loop', '0', `${OUT}/boot.gif`])

await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`,
  '-vf', scale, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
  '-movflags', '+faststart', `${OUT}/boot.mp4`])

await rm(FRAMES, { recursive: true, force: true })
console.log(`wrote ${OUT}/boot.gif and ${OUT}/boot.mp4`)
