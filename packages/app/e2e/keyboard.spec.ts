import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { Page } from '@playwright/test'
import { expect, forbidMouse, startServer, test, type Harness } from './fixtures.ts'

/**
 * The whole edit session, keyboard only.
 *
 * `forbidMouse` takes `page.mouse` away rather than trusting the test not to reach for it. "I did
 * not use the mouse" is not a property you can assert by reading a test: someone adds one
 * `.click()` to get a red test green and the guarantee is gone with no signal at all.
 *
 * This is also the test that stands in for react-grid-layout having no keyboard interaction. The
 * drag handles are unreachable by design; everything a person needs to do — add, configure,
 * remove, publish — has to be reachable without them.
 */

let harness: Harness
let stop: () => Promise<void>
let upstream: Server | null = null

test.beforeAll(async () => {
  const started = await startServer()
  harness = started.harness
  stop = started.stop

  // A stand-in Sonarr, so "Test connection" is a real request rather than a mocked green tick.
  upstream = createServer((req, res) => {
    if (req.headers['x-api-key'] !== 'KEYBOARD-KEY') {
      res.writeHead(401)
      res.end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"records":[{"title":"Ep","size":100,"sizeleft":25,"series":{"title":"Show"}}]}')
  })
  upstream.listen(9912, '127.0.0.1')
  await once(upstream, 'listening')
})

test.afterAll(async () => {
  upstream?.close()
  await stop()
})

/** Press Tab until the focused element matches, so the test does not depend on an exact count. */
async function tabTo(page: Page, predicate: string, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const matches = await page.evaluate((selector) => {
      const active = document.activeElement
      return active !== null && active.matches(selector)
    }, predicate)
    if (matches) return
    await page.keyboard.press('Tab')
  }
  const where = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? 'none')
  throw new Error(`never reached ${predicate} with Tab; focus ended on ${where}`)
}

test('a widget can be added end to end without a pointing device', async ({ page }) => {
  forbidMouse(page)
  await page.goto(`${harness.baseURL}/`)

  await tabTo(page, 'button.nh-fab')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()

  await tabTo(page, 'nav button')
  while (!(await page.evaluate(() => document.activeElement?.textContent === 'Widgets'))) {
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Enter')

  await tabTo(page, 'input[type="search"]')
  await page.keyboard.type('Sonarr')

  await tabTo(page, 'button.nh-catalog-item')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('group', { name: /Where it lives/i })).toBeVisible()

  await tabTo(page, '#neo-add-host')
  await page.keyboard.type('127.0.0.1')
  await page.keyboard.press('Tab')
  await page.keyboard.type('9912')

  await tabTo(page, 'input[type="password"]')
  await page.keyboard.type('KEYBOARD-KEY')

  // Test connection, driven from the keyboard against a real socket.
  while (!(await page.evaluate(() => document.activeElement?.textContent === 'Test connection'))) {
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Enter')
  await expect(page.locator('.nh-test-result')).toContainText(/Connected in/)

  while (!(await page.evaluate(() => document.activeElement?.textContent === 'Add widget'))) {
    await page.keyboard.press('Tab')
  }
  await page.keyboard.press('Enter')

  await expect(page.locator('article.nh-tile')).toHaveCount(1)
  await expect(page.locator('article.nh-tile')).toContainText('Sonarr queue')
})

test('Escape closes the editor and puts focus back where it started', async ({ page }) => {
  // Without this a keyboard user is dropped at the top of the document with no idea where they
  // were, which is the difference between "usable" and "technically operable".
  forbidMouse(page)
  await page.goto(`${harness.baseURL}/`)

  await tabTo(page, 'button.nh-fab')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await page.evaluate(() => document.activeElement?.className)).toContain('nh-fab')
})

test('focus stays inside the editor while it is open', async ({ page }) => {
  // `aria-modal="true"` tells a screen reader the rest of the page is inert. It does nothing about
  // Tab: without a trap, focus walks out of the dialog and onto a board the user was told is not
  // there, and the only way back is Shift+Tab past everything they just passed.
  forbidMouse(page)
  await page.goto(`${harness.baseURL}/`)

  await tabTo(page, 'button.nh-fab')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()

  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    )
    expect(inside, `focus left the dialog after ${i + 1} tab(s)`).toBe(true)
  }

  // And backwards, which is the direction a naive trap forgets.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab')
    const inside = await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    )
    expect(inside, `focus left the dialog after ${i + 1} back-tab(s)`).toBe(true)
  }
})

test('the mouse trap actually traps', ({ page }) => {
  // A guard nobody has seen fail is a guard nobody knows works. It throws synchronously, on the
  // property access — before Playwright ever gets a promise to reject.
  forbidMouse(page)
  expect(() => page.mouse.click(1, 1)).toThrow(/keyboard only/)
})
