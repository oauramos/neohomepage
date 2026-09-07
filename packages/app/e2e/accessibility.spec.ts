import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test, startServer, type Harness } from './fixtures.ts'

/**
 * Accessibility, checked by a real engine on a real render.
 *
 * The bar is axe's own: zero `serious` and zero `critical`. Moderate and minor findings are
 * reported but do not fail, because axe's moderate bucket includes judgement calls (landmark
 * nesting, heading order in a widget grid) that a dashboard can reasonably decide differently —
 * and a suite that fails on judgement calls is a suite people disable.
 */

let harness: Harness
let stop: () => Promise<void>

test.beforeAll(async () => {
  const started = await startServer()
  harness = started.harness
  stop = started.stop
})

test.afterAll(async () => {
  await stop()
})

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  )
  const other = results.violations.filter(
    (violation) => violation.impact !== 'serious' && violation.impact !== 'critical',
  )
  return { blocking, other, results }
}

function describeViolations(violations: { id: string; help: string; nodes: unknown[] }[]): string {
  return violations
    .map((violation) => `${violation.id} (${violation.nodes.length}×): ${violation.help}`)
    .join('\n')
}

test('the published board has no serious or critical violations', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.waitForSelector('#neo-root')

  const { blocking, other } = await scan(page)
  if (other.length > 0) console.log(`non-blocking:\n${describeViolations(other)}`)
  expect(describeViolations(blocking)).toBe('')
})

test('the editor has no serious or critical violations', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await expect(page.getByRole('dialog')).toBeVisible()

  const { blocking, other } = await scan(page)
  if (other.length > 0) console.log(`non-blocking:\n${describeViolations(other)}`)
  expect(describeViolations(blocking)).toBe('')
})

test('the widget catalog and its generated form are reachable and clean', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  await page.getByRole('button', { name: /Sonarr queue/ }).click()
  await expect(page.getByRole('group', { name: /Where it lives/i })).toBeVisible()

  const { blocking, other } = await scan(page)
  if (other.length > 0) console.log(`non-blocking:\n${describeViolations(other)}`)
  expect(describeViolations(blocking)).toBe('')
})

test('every form control the generated form emits has a label', async ({ page }) => {
  // The one thing a manifest-driven form gets wrong most easily: a new field kind renders an
  // input the label was never wired to, and it is invisible unless something checks.
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  await page.getByRole('button', { name: /Calendar/ }).click()

  const unlabelled = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('input, select, textarea')]
    return controls
      .filter((control) => {
        if (control.getAttribute('aria-label') !== null) return false
        const id = control.getAttribute('id')
        if (id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null) {
          return false
        }
        return control.closest('label') === null
      })
      .map((control) => control.outerHTML.slice(0, 120))
  })
  expect(unlabelled).toEqual([])
})
