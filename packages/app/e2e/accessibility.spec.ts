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

  // A bookmark tile, so the board carries the one element whose text sits on an accent FILL.
  // Scanning an empty board would pass every preset while proving nothing about the buttons.
  const target = await fetch(`${harness.baseURL}/api/targets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'Link',
      widgetType: 'service-link',
      base: { scheme: 'http', host: '127.0.0.1', port: 9914 },
      values: { label: 'Open', path: '/' },
    }),
  })
  const { id } = (await target.json()) as { id: string }
  await fetch(`${harness.baseURL}/api/widgets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'service-link', targetId: id, config: { label: 'Open' } }),
  })
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

function describeViolations(
  violations: {
    id: string
    help: string
    nodes: { target?: unknown[]; failureSummary?: string }[]
  }[],
): string {
  return violations
    .map((violation) => {
      // Naming the element and the measured ratio: "something on the page fails contrast" is not
      // a lead, and a colour failure is usually one selector rather than a palette-wide problem.
      const where = violation.nodes
        .map(
          (node) =>
            `\n    ${JSON.stringify(node.target)} ${(node.failureSummary ?? '').replaceAll('\n', ' ')}`,
        )
        .join('')
      return `${violation.id} (${violation.nodes.length}×): ${violation.help}${where}`
    })
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

/**
 * Every preset, scanned by axe on a board that actually has widgets.
 *
 * The contrast unit test checks the token palette — every text token against every surface — and
 * it passes for a preset whose bookmark button paints a SOLID accent fill while the stylesheet
 * still colours the label with `accent`. That is red-on-red, and only a real render catches it,
 * because the failing pair is a rule's choice of token rather than a value in the palette.
 */
for (const preset of ['default', 'nord', 'terminal', 'glass', 'brutalist', 'amber', 'synthwave']) {
  for (const mode of ['light', 'dark'] as const) {
    test(`the ${preset} preset reads in ${mode}`, async ({ page }) => {
      await fetch(`${harness.baseURL}/api/theme`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset, mode }),
      })
      await fetch(`${harness.baseURL}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })

      await page.goto(`${harness.baseURL}/`)
      await page.waitForSelector('#neo-root')

      const { blocking } = await scan(page)
      const contrast = blocking.filter((violation) => violation.id.includes('contrast'))
      expect(describeViolations(contrast), `${preset}/${mode} contrast`).toBe('')
      expect(describeViolations(blocking), `${preset}/${mode}`).toBe('')
    })
  }
}
