import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { Page } from '@playwright/test'
import { expect, forbidMouse, startServer, test, type Harness } from './fixtures.ts'

/**
 * The whole edit session, keyboard only. `forbidMouse` removes `page.mouse` so a stray `.click()`
 * fails loudly; react-grid-layout has no keyboard interaction, so everything must work without
 * its drag handles.
 */

let harness: Harness
let stop: () => Promise<void>
let upstream: Server | null = null

test.beforeAll(async () => {
  const started = await startServer()
  harness = started.harness
  stop = started.stop

  // Stand-in Sonarr so "Test connection" makes a real request.
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
async function tabTo(page: Page, selector: string, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const matches = await page.evaluate((selector) => {
      const active = document.activeElement
      return active !== null && active.matches(selector)
    }, selector)
    if (matches) return
    await page.keyboard.press('Tab')
  }
  const where = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? 'none')
  throw new Error(`never reached ${selector} with Tab; focus ended on ${where}`)
}

async function tabToText(page: Page, text: string, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const matches = await page.evaluate(
      (text) => document.activeElement?.textContent === text,
      text,
    )
    if (matches) return
    await page.keyboard.press('Tab')
  }
  const where = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? 'none')
  throw new Error(`never reached "${text}" with Tab; focus ended on ${where}`)
}

test('a widget can be added end to end without a pointing device', async ({ page }) => {
  forbidMouse(page)
  await page.goto(`${harness.baseURL}/`)

  await tabTo(page, 'button.nh-fab')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()

  await tabTo(page, 'nav button')
  await tabToText(page, 'Widgets')
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

  await tabToText(page, 'Test connection')
  await page.keyboard.press('Enter')
  await expect(page.locator('.nh-test-result')).toContainText(/Connected in/)

  await tabToText(page, 'Add widget')
  await page.keyboard.press('Enter')

  await expect(page.locator('article.nh-tile')).toHaveCount(1)
  await expect(page.locator('article.nh-tile')).toContainText('Sonarr queue')
})

test('Escape closes the editor and puts focus back where it started', async ({ page }) => {
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
  // `aria-modal` does not stop Tab from leaving the dialog; the focus trap has to.
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

  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab')
    const inside = await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    )
    expect(inside, `focus left the dialog after ${i + 1} back-tab(s)`).toBe(true)
  }
})

test('the mouse trap actually traps', ({ page }) => {
  // Throws synchronously on the property access, hence `toThrow` rather than `rejects`.
  forbidMouse(page)
  expect(() => page.mouse.click(1, 1)).toThrow(/keyboard only/)
})
