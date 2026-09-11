/**
 * Records the README demos against the harness board: the design panel recolouring a live board,
 * and the grid editor moving a tile. Playwright's video does not composite the pointer, so the
 * page draws one from the mouse events it receives, and `glide` paces moves over real time.
 *
 *   node scripts/demo/record.mjs
 *   node scripts/demo/record.mjs --only=design
 */
import { chromium } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import process from 'node:process'
import { startHarness, ROOT } from './harness.mjs'

const run = promisify(execFile)
const OUT = resolve(ROOT, 'media')
const WORK = resolve(ROOT, 'media/.frames')

const VIEWPORT = { width: 1280, height: 800 }
/** GitHub renders README images at about 890px wide, so the GIF is never upscaled. */
const GIF_WIDTH = 840
const FPS = 12
/** 96 colours suffice for flat surfaces and text; 256 costs hundreds of kilobytes for no gain. */
const GIF_COLOURS = 96

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null

/**
 * Pointer drawn by the page from real mouse events; white with a dark outline so it stays visible
 * on near-black and near-white presets.
 */
const CURSOR = `(() => {
  const layer = document.createElement('div')
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'

  const arrow = document.createElement('div')
  arrow.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;transform:translate(-999px,-999px)'
  arrow.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
    '<path d="M5 2.5 L5 18.2 L9.1 14.3 L11.7 20.4 L14.6 19.2 L12 13.2 L17.6 13.2 Z"' +
    ' fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'

  const ring = document.createElement('div')
  ring.style.cssText =
    'position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;' +
    'border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 1.5px rgba(0,0,0,.5);opacity:0;' +
    'will-change:transform,opacity;transform:translate(-999px,-999px) scale(.3)'

  layer.append(ring, arrow)
  const attach = () => document.body.appendChild(layer)
  if (document.body === null) document.addEventListener('DOMContentLoaded', attach)
  else attach()

  let x = -999
  let y = -999
  addEventListener(
    'mousemove',
    (event) => {
      x = event.clientX
      y = event.clientY
      arrow.style.transform = 'translate(' + x + 'px,' + y + 'px)'
    },
    { capture: true, passive: true },
  )
  addEventListener(
    'mousedown',
    () => {
      ring.style.transition = 'none'
      ring.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(.35)'
      ring.style.opacity = '1'
      requestAnimationFrame(() => {
        ring.style.transition = 'transform .42s ease-out, opacity .42s ease-out'
        ring.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(1)'
        ring.style.opacity = '0'
      })
    },
    { capture: true, passive: true },
  )
})()`

const wait = (page, ms) => page.waitForTimeout(ms)
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Where the pointer is, so a glide starts from where the last one left it. */
let at = { x: VIEWPORT.width / 2, y: VIEWPORT.height - 40 }

async function glide(page, x, y, ms = 520) {
  const steps = Math.max(2, Math.round((ms / 1000) * FPS * 1.6))
  const from = at
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps)
    await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t)
    await wait(page, ms / steps)
  }
  at = { x, y }
}

const centre = async (locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('the element being aimed at is not on screen')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function clickAt(page, locator, { hold = 90 } = {}) {
  const point = await centre(locator)
  await glide(page, point.x, point.y)
  await page.mouse.down()
  await wait(page, hold)
  await page.mouse.up()
}

/** A press, a slow path, and a release — so RGL animates rather than teleports. */
async function dragTo(page, dx, dy, ms = 900) {
  await page.mouse.down()
  await wait(page, 160)
  const from = { ...at }
  const steps = Math.max(4, Math.round((ms / 1000) * FPS * 1.6))
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps)
    await page.mouse.move(from.x + dx * t, from.y + dy * t)
    await wait(page, ms / steps)
  }
  at = { x: from.x + dx, y: from.y + dy }
  await wait(page, 220)
  await page.mouse.up()
}

/** Opens the board on the fresh-install theme so scenes do not inherit each other's preset. */
async function openBoard(context, baseURL) {
  const page = await context.newPage()
  await page.addInitScript(CURSOR)
  await page.request.patch(`${baseURL}/api/theme`, {
    data: { preset: 'default', mode: 'light', surface: { background: null } },
  })
  await page.request.post(`${baseURL}/api/publish`, { data: {} })
  await page.goto(baseURL)
  await page.waitForSelector('article.nh-tile')
  // The FABs only exist once the editor bundle has hydrated.
  await page.waitForSelector('button.nh-fab-design')
  await page.mouse.move(at.x, at.y)
  await wait(page, 900)
  return page
}

/** Colour: the design panel, dark mode, two presets, and one slider the board follows live. */
async function design(context, baseURL) {
  const page = await openBoard(context, baseURL)

  await clickAt(page, page.locator('button.nh-fab-design'))
  await wait(page, 700)

  // Dark first: the presets differ far more from each other in dark mode.
  await clickAt(page, page.locator('.nh-seg-item', { hasText: 'Dark' }).first())
  await wait(page, 900)

  for (const preset of ['Nord', 'Terminal']) {
    await clickAt(page, page.locator('.nh-preset', { hasText: preset }).first())
    await wait(page, 850)
  }

  await clickAt(page, page.getByRole('button', { name: 'Shape', exact: true }))
  await wait(page, 450)

  const slider = page.locator('input[type=range]').first()
  const box = await slider.boundingBox()
  await glide(page, box.x + box.width * 0.02, box.y + box.height / 2)
  await dragTo(page, box.width * 0.62, 0, 1100)
  await wait(page, 900)

  await page.keyboard.press('Escape')
  await wait(page, 1300)
  return page
}

/** Layout: edit mode, one tile dragged by its handle, and the board reflowing under it. */
async function layout(context, baseURL) {
  const page = await openBoard(context, baseURL)

  await clickAt(page, page.locator('button.nh-fab-editor'))
  await wait(page, 650)
  // The tab and the button it reveals share a name; the one that turns edit mode on is the button.
  await clickAt(page, page.locator('button.nh-button', { hasText: 'Edit layout' }))
  await wait(page, 900)

  // Pi-hole crosses two tiles on its way to the left column, so the reflow is visible.
  const handle = page.locator('.nh-editor-cell', { hasText: 'Pi-hole' }).locator('.nh-drag-handle')
  const grip = await centre(handle)
  await glide(page, grip.x, grip.y)
  // Aimed slightly above the row: dropped level, RGL settles the tile one slot below.
  await dragTo(page, -840, -34, 1050)
  await wait(page, 1800)
  return page
}

/** One still per preset, for the README's theme strip. No cursor, no motion. */
async function stills(context, baseURL) {
  const page = await context.newPage()
  await page.goto(baseURL)
  await page.waitForSelector('button.nh-fab-design')

  for (const [preset, file] of [
    ['default', 'theme-default'],
    ['nord', 'theme-nord'],
    ['terminal', 'theme-terminal'],
  ]) {
    await page.request.patch(`${baseURL}/api/theme`, {
      data: { preset, mode: preset === 'default' ? 'light' : 'dark' },
    })
    // Publishing is manual here, and the still is of the published page.
    await page.request.post(`${baseURL}/api/publish`, { data: {} })
    await page.reload()
    await page.waitForSelector('article.nh-tile')
    await wait(page, 1200)
    await page.screenshot({ path: join(OUT, `${file}.png`) })
    console.log(`wrote media/${file}.png`)
  }
  await page.request.patch(`${baseURL}/api/theme`, { data: { preset: 'default', mode: 'system' } })
  await page.request.post(`${baseURL}/api/publish`, { data: {} })
  await page.close()
}

/**
 * webm -> mp4 -> GIF. The x264 pass smooths VP8 encoder noise that breaks GIF's LZW runs (~30%
 * smaller). One palette for the whole clip and no dithering, or flat surfaces shimmer frame to
 * frame.
 */
async function encode(webm, name) {
  const mp4 = join(OUT, `${name}.mp4`)
  await run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    webm,
    '-vf',
    `scale=${VIEWPORT.width}:-2:flags=lanczos`,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '22',
    '-movflags',
    '+faststart',
    mp4,
  ])

  const scale = `fps=${FPS},scale=${GIF_WIDTH}:-2:flags=lanczos`
  const palette = join(WORK, `${name}-palette.png`)
  await run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    mp4,
    '-vf',
    `${scale},palettegen=max_colors=${GIF_COLOURS}:stats_mode=full`,
    palette,
  ])
  await run('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    mp4,
    '-i',
    palette,
    '-lavfi',
    `${scale}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop',
    '0',
    join(OUT, `${name}.gif`),
  ])
}

const scenes = { design, layout }
if (only !== null && only !== 'stills' && !Object.hasOwn(scenes, only)) {
  throw new Error(`--only must be one of stills, ${Object.keys(scenes).join(', ')}`)
}

await mkdir(OUT, { recursive: true })
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

const harness = await startHarness()
console.log(`board seeded: ${harness.widgets.length} widgets at ${harness.baseURL}`)
const browser = await chromium.launch()

try {
  if (only === null || only === 'stills') {
    const context = await browser.newContext({ viewport: VIEWPORT })
    await stills(context, harness.baseURL)
    await context.close()
  }

  for (const [name, scene] of Object.entries(scenes)) {
    if (only !== null && only !== name) continue
    at = { x: VIEWPORT.width / 2, y: VIEWPORT.height - 40 }
    const dir = join(WORK, name)
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir, size: VIEWPORT },
    })
    const page = await scene(context, harness.baseURL)
    await page.close()
    await context.close()

    const [file] = await readdir(dir)
    await encode(join(dir, file), `demo-${name}`)
    console.log(`wrote media/demo-${name}.gif and media/demo-${name}.mp4`)
  }
} finally {
  await browser.close()
  await harness.stop()
}

await rm(WORK, { recursive: true, force: true })
