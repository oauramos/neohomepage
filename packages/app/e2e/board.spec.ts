import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { expect, readState, sendJson, startServer, test, type Harness } from './fixtures.ts'
import type { Page } from '@playwright/test'

/**
 * The published board in a real browser: the no-JavaScript path and the widths people use, which
 * only a layout engine can check.
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
    const { id } = await sendJson<{ id: string }>(`${harness.baseURL}/api/targets`, {
      label,
      widgetType: type,
      base: { scheme: 'http', host: '127.0.0.1', port: 9913 },
      values: { apiKey: 'x', label: 'Open', path: 'x' },
    })
    await sendJson(`${harness.baseURL}/api/widgets`, { type, targetId: id })
  }
  await sendJson(`${harness.baseURL}/api/publish`, {})
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

    // The published page carries a `calc()` grid mirroring react-grid-layout's formula; check it
    // reached the browser.
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
      // More than one column, so at least two tiles share a row.
      expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBeLessThan(boxes.length)
    } else {
      // The narrow tier is two columns and a default widget spans both, so tiles are stacked and
      // full width; check they expanded to the column rather than to their content width.
      for (const box of boxes) expect(box.w).toBeGreaterThan(viewport * 0.6)
    }
  })

  test('the editor button is absent rather than present and dead', async ({ page }) => {
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
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  })
}

/** Visible controls smaller than WCAG 2.5.8's 24×24 CSS pixels. */
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
  // The FABs and the editor's tabs are the smallest controls on the page.
  await page.setViewportSize({ width: 380, height: 800 })
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-editor').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await undersizedControls(page)).toEqual([])
})

test('the design panel is reachable by thumb too', async ({ page }) => {
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
  // Regression: inputs controlled by the theme returned from the server re-rendered every drag
  // frame with the previous value, pulling the thumb back under the cursor.
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
      // Painting is coalesced to an animation frame, so the page may be exactly one frame behind.
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

  // The write is debounced, not dropped: the last value reaches the server.
  await expect
    .poll(
      async () => {
        const state = await readState(page, harness.baseURL)
        return state.resolved.theme.cssVars.theme.radius
      },
      { timeout: 5000 },
    )
    .toBe('28px')
})

/** Resets the theme to stock; tests share one server. */
async function clearTheme(page: Page) {
  const state = await readState(page, harness.baseURL)
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
  // Regression: exact equality against a whole font stack marked no stack active, because a
  // preset may append families and space its list differently.
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
  // Regression: a debounced slider write landing after a preset switch wrote itself into the new
  // preset. Earlier tests leave overrides on the shared server, so start from stock.
  await clearTheme(page)
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()
  await page.getByRole('button', { name: 'Shape', exact: true }).click()
  await page.locator('input[type=range]').first().fill('7')

  // Switch while the write is still queued.
  await page.getByRole('button', { name: 'Themes', exact: true }).click()
  await page.locator('.nh-preset', { hasText: 'Terminal' }).first().click()

  await expect
    .poll(
      async () => {
        const state = await readState(page, harness.baseURL)
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
        const state = await readState(page, harness.baseURL)
        return Object.keys(state.resolved.theme.cssVars.theme).length
      },
      { timeout: 5000 },
    )
    .toBe(0)
})

test('board width is a scale of icons, and exactly one is on', async ({ page }) => {
  await clearTheme(page)
  await page.goto(`${harness.baseURL}/`)
  await page.locator('button.nh-fab-design').click()
  await page.getByRole('button', { name: 'Shape', exact: true }).click()

  const widths = page.locator('.nh-width')
  await expect(widths).toHaveCount(4)
  await expect(page.locator('.nh-width[aria-pressed="true"]')).toHaveCount(1)

  for (const [label, expected] of [
    ['Narrow', '1200px'],
    ['Full bleed', 'none'],
    ['Wide', '2000px'],
  ] as const) {
    await page.locator(`.nh-width[title="${label}"]`).click()
    await expect(page.locator(`.nh-width[title="${label}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator('.nh-width[aria-pressed="true"]')).toHaveCount(1)
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--nh-max-width').trim(),
        ),
      )
      .toBe(expected)
  }
})

test('a dragged tile stays under the pointer, and the move is a draft until saved', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'no drag on the phone tier')
  const revision = async () => (await readState(page, harness.baseURL)).revision
  const before = await revision()

  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click()
  await page.waitForSelector('.react-grid-layout')

  // DOM order is widget order, not layout order, so `first()` could already be at the right edge.
  const leftmost = async () => {
    const boxes = await page
      .locator('.nh-drag-handle')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as DOMRect))
    return boxes.reduce((min, box) => (box.x < min.x ? box : min))
  }
  const box = await leftmost()
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(start.x + step * 30, start.y + step * 10, { steps: 2 })
  }

  // Mid-drag the handle is under the pointer; without the grid's positioning rules it drifted.
  const dragged = await page
    .locator('.react-draggable-dragging .nh-drag-handle')
    .evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
  expect(Math.abs(dragged.x - (start.x + 300))).toBeLessThan(3)
  expect(Math.abs(dragged.y - (start.y + 100))).toBeLessThan(3)
  await expect(page.locator('.react-grid-placeholder')).toBeVisible()
  await page.mouse.up()

  await expect(page.locator('.nh-editbar')).toContainText('1 unsaved change')
  expect(await revision()).toBe(before)

  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.nh-editbar')).toContainText('Save or discard')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.locator('.nh-editbar')).not.toContainText('unsaved')
  expect(await revision()).toBe(before)
  // Tiles glide back over 200ms; measure after they settle.
  await page.waitForTimeout(400)

  // A drop on the same cell is not a change.
  const same = await leftmost()
  await page.mouse.move(same.x + 5, same.y + 5)
  await page.mouse.down()
  await page.mouse.move(same.x + 20, same.y + 8, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.nh-editbar')).not.toContainText('unsaved')

  const again = await leftmost()
  await page.mouse.move(again.x + 5, again.y + 5)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(again.x + 5 + step * 40, again.y + 5, { steps: 2 })
  }
  await page.mouse.up()
  await expect(page.locator('.nh-editbar')).toContainText('1 unsaved change')
  await page.getByRole('button', { name: 'Save layout', exact: true }).click()
  // "Saving…" also lacks "unsaved"; the idle line only returns once the write has landed.
  await expect(page.locator('.nh-editbar')).toContainText('Nothing is saved until')
  expect(await revision()).not.toBe(before)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.nh-editbar')).toHaveCount(0)
})

test('a tile can be removed and resized from edit mode', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'the layout editor is a desktop affordance')
  const widgets = async () => (await readState(page, harness.baseURL)).resolved.widgets.length
  const before = await widgets()

  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click()
  await page.waitForSelector('.react-grid-layout')

  const size = page.locator('.nh-editor-size').first()
  await size.selectOption('2x2')
  await expect(page.locator('.nh-editbar')).toContainText('unsaved change')
  // The tile glides to its new width over 200ms; poll rather than read once.
  await expect
    .poll(async () => {
      const shrunk = await page.locator('.react-grid-item').first().boundingBox()
      const other = await page.locator('.react-grid-item').nth(1).boundingBox()
      return shrunk !== null && other !== null && shrunk.width < other.width - 40
    })
    .toBe(true)

  await page.locator('.nh-editor-remove').first().click()
  await expect(page.locator('.react-grid-item')).toHaveCount(before - 1)
  expect(await widgets()).toBe(before - 1)
})
