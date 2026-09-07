import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { expect, startServer, test, type Harness } from './fixtures.ts'
import type { Page } from '@playwright/test'

/**
 * The board as a document: with JavaScript off, and at the widths people actually use.
 *
 * The static path is the product's main claim — a start page that is a file, not an app — and it
 * is the one that cannot be checked without a real layout engine. A unit test can assert the HTML
 * contains a tile; only a browser can say whether the tile is where the grid said it would be.
 */

let harness: Harness
let stop: () => Promise<void>
let upstream: Server | null = null

test.beforeAll(async () => {
  const started = await startServer()
  harness = started.harness
  stop = started.stop

  upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"records":[{"title":"Ep","size":100,"sizeleft":25,"series":{"title":"Show"}}]}')
  })
  upstream.listen(9913, '127.0.0.1')
  await once(upstream, 'listening')

  // Three widgets, so the layout has something to lay out.
  for (const [label, type] of [
    ['Sonarr', 'sonarr-queue'],
    ['Uptime', 'uptime-kuma-status'],
    ['Link', 'service-link'],
  ]) {
    const target = await fetch(`${harness.baseURL}/api/targets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label,
        widgetType: type,
        base: { scheme: 'http', host: '127.0.0.1', port: 9913 },
        values: { apiKey: 'x', label: 'Open', path: 'x' },
      }),
    })
    const { id } = (await target.json()) as { id: string }
    await fetch(`${harness.baseURL}/api/widgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, targetId: id }),
    })
  }
  await fetch(`${harness.baseURL}/api/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
})

test.afterAll(async () => {
  upstream?.close()
  await stop()
})

test.describe('with JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false })

  test('the board is complete, laid out and readable', async ({ page }) => {
    await page.goto(`${harness.baseURL}/`)

    const tiles = page.locator('article.nh-tile')
    await expect(tiles).toHaveCount(3)

    // Laid out, not stacked in the corner: the published page carries a `calc()` grid mirroring
    // react-grid-layout's own formula, and this is what proves it survives to the browser.
    const boxes = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, w: box.width, h: box.height }
      }),
    )
    for (const box of boxes) {
      expect(box.w).toBeGreaterThan(80)
      expect(box.h).toBeGreaterThan(40)
    }

    const viewport = page.viewportSize()?.width ?? 0
    if (viewport >= 768) {
      // Wide enough for more than one column, so at least two tiles share a row — which cannot
      // happen if the grid CSS did not reach the browser.
      expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBeLessThan(boxes.length)
    } else {
      // At the narrow tier the grid is two columns and a default widget spans both, so every tile
      // IS full width and stacked. That is the grid working, not failing — the proof here is that
      // tiles expanded to the column rather than sitting at some intrinsic content width.
      for (const box of boxes) expect(box.w).toBeGreaterThan(viewport * 0.6)
    }
  })

  test('the editor button is absent rather than present and dead', async ({ page }) => {
    // A control that does nothing is worse than no control: it teaches the user the page is
    // broken rather than that this view is static.
    await page.goto(`${harness.baseURL}/`)
    await expect(page.locator('button.nh-fab')).toHaveCount(0)
  })
})

for (const width of [1400, 900, 380]) {
  test(`the board fits at ${width}px with nothing overflowing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${harness.baseURL}/`)
    await page.waitForSelector('article.nh-tile')

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    // A page that scrolls sideways on a phone is the single most common responsive failure, and
    // the one people notice first.
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  })
}

/** Every visible control, with the ones under WCAG 2.5.8's 24×24 named. */
async function undersizedControls(page: Page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select')]
    return controls
      .filter((control) => control.offsetParent !== null)
      .map((control) => {
        const box = control.getBoundingClientRect()
        return { html: control.outerHTML.slice(0, 80), w: box.width, h: box.height }
      })
      .filter((entry) => entry.w < 24 || entry.h < 24)
  })
}

test('every control is big enough to hit on a touchscreen', async ({ page }) => {
  // WCAG 2.5.8 (AA): 24×24 CSS pixels. The FABs and the editor's tabs are the controls a phone
  // user reaches for, and they are also the smallest things on the page.
  await page.setViewportSize({ width: 380, height: 800 })
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-editor').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await undersizedControls(page)).toEqual([])
})

test('the design panel is reachable by thumb too', async ({ page }) => {
  // The panel is a second modal full of small controls — swatches, sliders, segmented buttons —
  // and it is the surface most likely to grow one that is too small to hit.
  await page.setViewportSize({ width: 380, height: 800 })
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await undersizedControls(page)).toEqual([])

  // Each section renders a different set of controls, so one open dialog checks only one of them.
  for (const section of ['Colour', 'Shape', 'Type', 'Background']) {
    await page.getByRole('button', { name: section, exact: true }).click()
    expect(await undersizedControls(page), `${section} section`).toEqual([])
  }
})

test('a design control follows the pointer instead of the last round trip', async ({ page }) => {
  // The regression this exists for: the panel's inputs were controlled by the theme that came back
  // from the server, so every drag frame re-rendered them with the PREVIOUS value and the thumb was
  // pulled back under the cursor. The control looked dead. Nothing in the unit suite can see it —
  // it only exists once a real input event races a real fetch.
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()
  await page.getByRole('button', { name: 'Shape', exact: true }).click()

  const slider = page.locator('input[type=range]').first()
  const seen: { sent: string; shows: string; painted: string }[] = []

  for (const value of ['4', '10', '16', '22', '28']) {
    await slider.fill(value)
    seen.push({
      sent: value,
      shows: await slider.inputValue(),
      painted: await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--nh-radius').trim(),
      ),
    })
  }

  // Every frame: the input shows what was sent, and the page is already painted with it.
  expect(seen).toEqual(
    ['4', '10', '16', '22', '28'].map((value) => ({
      sent: value,
      shows: value,
      painted: `${value}px`,
    })),
  )

  // And the write is debounced rather than dropped: the last value survives a reload.
  await expect
    .poll(
      async () => {
        const state = (await (await page.request.get(`${harness.baseURL}/api/state`)).json()) as {
          resolved: { theme: { cssVars: { theme: Record<string, string> } } }
        }
        return state.resolved.theme.cssVars.theme.radius
      },
      { timeout: 5000 },
    )
    .toBe('28px')
})
