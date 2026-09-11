import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test, sendJson, startServer, type Harness } from './fixtures.ts'

/**
 * Axe scans of real renders. Only `serious` and `critical` fail; moderate and minor findings are
 * logged, since axe's moderate bucket includes judgement calls a dashboard can reasonably make.
 */

let harness: Harness
let stop: () => Promise<void>

test.beforeAll(async () => {
  const started = await startServer()
  harness = started.harness
  stop = started.stop

  // A bookmark tile puts text on an accent fill; an empty board would pass every preset.
  const { id } = await sendJson<{ id: string }>(`${harness.baseURL}/api/targets`, {
    label: 'Link',
    widgetType: 'service-link',
    base: { scheme: 'http', host: '127.0.0.1', port: 9914 },
    values: { label: 'Open', path: '/' },
  })
  await sendJson(`${harness.baseURL}/api/widgets`, {
    type: 'service-link',
    targetId: id,
    config: { label: 'Open' },
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
  return { blocking, other }
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

async function expectClean(page: Page): Promise<void> {
  const { blocking, other } = await scan(page)
  if (other.length > 0) console.log(`non-blocking:\n${describeViolations(other)}`)
  expect(describeViolations(blocking)).toBe('')
}

test('the published board has no serious or critical violations', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.waitForSelector('#neo-root')
  await expectClean(page)
})

test('the editor has no serious or critical violations', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectClean(page)
})

test('the sections editor is reachable, saves, and is clean with every kind expanded', async ({
  page,
}) => {
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Sections', exact: true }).click()

  // A page that never declared sections shows the implicit pair, and adding one saves whole.
  await expect(page.getByRole('button', { name: /Header/ })).toBeVisible()
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click()
  await page.getByRole('button', { name: '+ Add link' }).click()
  await expect(page.getByRole('textbox', { name: 'URL' })).toBeVisible()
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.baseURL}/api/pages/home`)
      const body = (await response.json()) as { sections: { kind: string }[] }
      return body.sections.map((section) => section.kind)
    })
    .toEqual(['navbar', 'grid', 'bookmarks'])

  await page.getByRole('button', { name: /Header/ }).click()
  await page
    .getByRole('button', { name: /Untitled/ })
    .first()
    .click()
  await expectClean(page)
})

test('the widget catalog and its generated form are reachable and clean', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  // The catalog opens on Browse (or on typing); the placed list is what the tab shows at rest.
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
  await page.getByRole('button', { name: /Sonarr queue/ }).click()
  await expect(page.getByRole('group', { name: /Where it lives/i })).toBeVisible()
  await expectClean(page)
})

test('every form control the generated form emits has a label', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)
  await page.getByRole('button', { name: /editor/i }).click()
  await page.getByRole('button', { name: 'Widgets', exact: true }).click()
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
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

// The palette unit test cannot catch a rule that colours a label with the same accent token the
// button fills with; only a real render does.
for (const preset of [
  'default',
  'nord',
  'terminal',
  'glass',
  'brutalist',
  'amber',
  'synthwave',
  '8bit',
  '16bit',
  '32bit',
  '64bit',
]) {
  for (const mode of ['light', 'dark'] as const) {
    test(`the ${preset} preset reads in ${mode}`, async ({ page }) => {
      await sendJson(`${harness.baseURL}/api/theme`, { preset, mode }, 'PATCH')
      await sendJson(`${harness.baseURL}/api/publish`, {})

      await page.goto(`${harness.baseURL}/`)
      await page.waitForSelector('#neo-root')

      const { blocking } = await scan(page)
      const contrast = blocking.filter((violation) => violation.id.includes('contrast'))
      expect(describeViolations(contrast), `${preset}/${mode} contrast`).toBe('')
      expect(describeViolations(blocking), `${preset}/${mode}`).toBe('')
    })
  }
}
