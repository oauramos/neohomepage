/**
 * Record the README demos: the design panel recolouring a live board, and the grid editor moving
 * a tile.
 *
 * The recording is of the product, not of a mockup. `harness.mjs` boots the real server on a
 * throwaway data directory in front of one stub per widget, so every number on screen came
 * through the real fetcher and projection from that widget's own recorded fixture.
 *
 * Two things are added that a user would not see, both so the recording is readable:
 *
 *  - A cursor. Playwright's video does not composite the pointer, so without one every click looks
 *    like the UI acting on its own. It is drawn by the page from real mouse events rather than
 *    positioned from here, which means it cannot drift out of sync with what is being clicked.
 *  - Pacing. `page.mouse.move(x, y, {steps})` dispatches its steps as fast as the process can, and
 *    at 20fps that is one frame — a teleport. `glide` spreads the same path over real time.
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
/** GitHub renders a README image at about 890px, so 880 is never upscaled and never wasted. */
const GIF_WIDTH = 840
const FPS = 12
/**
 * 96 rather than 256. The board is flat surfaces and text, so the rest of the palette buys no
 * visible fidelity and costs hundreds of kilobytes — real weight on a README someone opens on a
 * phone. The clip that decides this is the layout one: a tile crossing the board changes most of
 * the frame most of the time, so it is the one with nothing to gain from inter-frame diffing.
 */
const GIF_COLOURS = 96

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null

/**
 * The pointer, drawn by the page from the events it actually receives.
 *
 * Filled white with a dark outline because it has to stay visible against seven presets, three of
 * which are near-black and one of which is near-white.
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

/**
 * A scene starts from the theme a fresh install shows, whatever ran before it.
 *
 * Without this the clips inherit each other: recording both in one pass left the layout demo in
 * the Terminal preset the design demo had just switched to, and `--only=layout` produced something
 * different again. Two clips of the same product should open on the same board.
 */
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

/** Colour: the panel, three presets, and one slider the board follows in real time. */
async function design(context, baseURL) {
  const page = await openBoard(context, baseURL)

  await clickAt(page, page.locator('button.nh-fab-design'))
  await wait(page, 700)

  // Scheme first. Six of the seven presets are far more distinct from each other in the dark, and
  // a demo that stays light spends three clicks showing changes the viewer has to hunt for.
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

/**
 * Layout: edit mode, a tile moved by its handle, and the board reflowing under it.
 *
 * One gesture rather than a tour. Resizing was in an earlier cut and had to go: it doubled the
 * clip and the file, and the second drag taught nothing the first had not.
 */
async function layout(context, baseURL) {
  const page = await openBoard(context, baseURL)

  await clickAt(page, page.locator('button.nh-fab-editor'))
  await wait(page, 650)
  // The tab and the button it reveals share a name; the one that turns edit mode on is the button.
  await clickAt(page, page.locator('button.nh-button', { hasText: 'Edit layout' }))
  await wait(page, 900)

  // Pi-hole out of the right column and into the left: the two tiles it passes have to get out of
  // the way, which is the part that shows this is a grid rather than a list.
  const handle = page.locator('.nh-editor-cell', { hasText: 'Pi-hole' }).locator('.nh-drag-handle')
  const grip = await centre(handle)
  await glide(page, grip.x, grip.y)
  // Aimed at the top row rather than level with it: dropped level, RGL settles the tile into the
  // slot below the one it was aimed at, and the clip ends on a board where nothing obviously moved.
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
 * webm to mp4, then mp4 to GIF — in that order, and the order is the point.
 *
 * Playwright's VP8 output carries encoder noise that is invisible to the eye and expensive to a
 * GIF: LZW compresses runs of identical indices, and noise breaks every run. Passing through x264
 * first smooths it, and the same clip at the same size comes out about 30% smaller with no
 * difference anyone can see on a board made of flat panels and text.
 *
 * One palette for the whole clip rather than per frame: the flat surfaces quantise to
 * adjacent-but-different colours frame to frame otherwise, and a tile nobody touched shimmers for
 * the length of the clip. Undithered for the same reason the boot animation is — dithering a flat
 * field is visible noise, and here it also costs 40% more bytes.
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
