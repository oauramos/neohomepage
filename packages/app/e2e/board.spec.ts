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
      // The control must never lag: its value is local state, settled before the event returns.
      shows: await slider.inputValue(),
      // The PAGE is allowed exactly one frame. Painting is coalesced to an animation frame on
      // purpose — a drag emits events faster than a board of tiles can repaint, and painting every
      // one builds a backlog that reads as lag. One frame behind is not lag; a queue is.
      painted: await page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve(
                  getComputedStyle(document.documentElement).getPropertyValue('--nh-radius').trim(),
                ),
              ),
            )
          }),
      ),
    })
  }

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

/** Put the theme back to stock, so a test's claim is about what it did rather than what ran before. */
async function clearTheme(page: Page) {
  const state = (await (await page.request.get(`${harness.baseURL}/api/state`)).json()) as {
    resolved: { theme: { cssVars: Record<'theme' | 'light' | 'dark', Record<string, string>> } }
  }
  const cssVars = Object.fromEntries(
    (['theme', 'light', 'dark'] as const).map((bucket) => [
      bucket,
      Object.fromEntries(Object.keys(state.resolved.theme.cssVars[bucket]).map((k) => [k, null])),
    ]),
  )
  await page.request.patch(`${harness.baseURL}/api/theme`, {
    data: { preset: 'default', mode: 'system', cssVars, surface: { background: null } },
  })
}

test('the type control shows which stack every preset is on', async ({ page }) => {
  // Exact string equality against a whole font stack marked nothing as active on six of the seven
  // presets, because a preset may append families and write its list with spaces. The control was
  // not broken so much as permanently blank, which looks the same from the outside.
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()

  for (const [preset, expected] of [
    ['Default', 'Sans'],
    ['Nord', 'Sans'],
    ['Terminal', 'Mono'],
    ['Brutalist', 'Grotesque'],
    ['Amber', 'Serif'],
  ] as const) {
    await page.getByRole('button', { name: 'Themes', exact: true }).click()
    await page.locator('.nh-preset', { hasText: preset }).first().click()
    await page.getByRole('button', { name: 'Type', exact: true }).click()
    await expect(
      page.locator('.nh-seg-item[aria-pressed="true"]', { hasText: expected }),
      `${preset} should show ${expected} as the active stack`,
    ).toHaveCount(1)
  }
})

test('switching preset discards a nudge that was aimed at the old one', async ({ page }) => {
  // The debounce made this reachable: move a slider, immediately pick a preset, and the pending
  // write lands AFTER the switch and writes itself into the theme you just chose. Measured once as
  // radius 6px inside Terminal, whose own radius is 0.
  // Earlier tests in this file leave overrides on the shared server, so start from a known theme
  // rather than from whatever ran last: the claim here is about ONE nudge, not about the store.
  await clearTheme(page)
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()
  await page.getByRole('button', { name: 'Shape', exact: true }).click()
  await page.locator('input[type=range]').first().fill('7')

  // No wait: the point is to switch while the write is still queued.
  await page.getByRole('button', { name: 'Themes', exact: true }).click()
  await page.locator('.nh-preset', { hasText: 'Terminal' }).first().click()

  await expect
    .poll(
      async () => {
        const state = (await (await page.request.get(`${harness.baseURL}/api/state`)).json()) as {
          resolved: { theme: { preset: string; cssVars: { theme: Record<string, string> } } }
        }
        return `${state.resolved.theme.preset}:${Object.keys(state.resolved.theme.cssVars.theme).length}`
      },
      { timeout: 5000 },
    )
    .toBe('terminal:0')

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--nh-radius').trim(),
      ),
    )
    .toBe('0px')
})

test('custom values are counted and clearable', async ({ page }) => {
  // An override outlives the preset it was made under, which is right and invisible: the board
  // stops matching the card you clicked and nothing explains it.
  await clearTheme(page)
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()
  await expect(page.locator('.nh-overrides')).toHaveCount(0)

  await page.getByRole('button', { name: 'Shape', exact: true }).click()
  await page.locator('input[type=range]').first().fill('19')
  await expect(page.locator('.nh-overrides')).toContainText('custom')

  await page.locator('.nh-overrides button').click()
  await expect(page.locator('.nh-overrides')).toHaveCount(0)
  await expect
    .poll(
      async () => {
        const state = (await (await page.request.get(`${harness.baseURL}/api/state`)).json()) as {
          resolved: { theme: { cssVars: { theme: Record<string, string> } } }
        }
        return Object.keys(state.resolved.theme.cssVars.theme).length
      },
      { timeout: 5000 },
    )
    .toBe(0)
})
