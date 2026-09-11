import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectionEnvelope } from '@neohomepage/catalog-schema'
import { dashboard, isTemplate, TEMPLATES, widgetTile } from './board.ts'
import type { Resolved, ResolvedWidget } from './resolved.ts'

const widget = (overrides: Partial<ResolvedWidget> = {}): ResolvedWidget => ({
  id: 'w1',
  page: 'home',
  type: 'sonarr-queue',
  title: 'Sonarr queue',
  template: 'list',
  bindings: {},
  icon: 'sonarr',
  targetId: 'tSonarr',
  config: {},
  operations: ['queue'],
  pollIntervalMs: 60_000,
  unsupported: false,
  href: null,
  ...overrides,
})

const envelope = (overrides: Partial<ProjectionEnvelope> = {}): ProjectionEnvelope =>
  ({
    projection: { stats: [{ label: 'Queue', value: 2 }] },
    meta: { fetchedAt: '2026-09-06T12:00:00.000Z', ageMs: 0, state: 'fresh' },
    ...overrides,
  }) as ProjectionEnvelope

const html = (node: unknown) => renderToStaticMarkup(node as never)

describe('a widget with no data', () => {
  it('renders a placeholder when nothing has been fetched yet', () => {
    expect(html(widgetTile(widget(), undefined))).toContain('No data yet')
  })

  it('renders a placeholder when the projection is null, rather than crashing', () => {
    // This is the regression. A widget that has never succeeded carries `projection: null` with
    // an error code, and the renderer used to read `.stats` straight off it — taking the entire
    // page down on first paint, before any service had answered.
    const failed = {
      projection: null,
      meta: { fetchedAt: null, ageMs: 0, state: 'error', errorCode: 'refused' },
    } as unknown as ProjectionEnvelope

    for (const template of TEMPLATES) {
      expect(() => html(widgetTile(widget({ template }), failed)), template).not.toThrow()
    }
    const rendered = html(widgetTile(widget(), failed))
    expect(rendered).toContain('Unavailable')
    // The code reaches the reader through the chip; nothing else about the failure does.
    expect(rendered).toContain('refused')
  })

  it('shows a labelled placeholder for a type the catalog does not have', () => {
    const rendered = html(widgetTile(widget({ unsupported: true, type: 'mystery' }), undefined))
    expect(rendered).toContain('Unknown widget type')
    expect(rendered).toContain('mystery')
  })
})

describe('templates', () => {
  it('recognises exactly the five it compiles in', () => {
    expect([...TEMPLATES]).toEqual(['stat-grid', 'list', 'gauge-set', 'status-badge', 'link-tile'])
    for (const template of TEMPLATES) expect(isTemplate(template)).toBe(true)
    expect(isTemplate('timeline')).toBe(false)
  })

  it('renders a template this build does not have as a labelled placeholder', () => {
    // A manifest from a newer catalog naming a template we cannot draw must say so, not render
    // an empty tile that looks like a bug in the service.
    const rendered = html(widgetTile(widget({ template: 'timeline' }), envelope()))
    expect(rendered).toContain('Unsupported layout')
  })

  it('renders stats for stat-grid', () => {
    const rendered = html(widgetTile(widget({ template: 'stat-grid' }), envelope()))
    expect(rendered).toContain('Queue')
    expect(rendered).toContain('2')
  })

  it('renders items for list', () => {
    const rendered = html(
      widgetTile(
        widget({ template: 'list' }),
        envelope({ projection: { items: [{ title: 'Andor', subtitle: 'downloading' }] } }),
      ),
    )
    expect(rendered).toContain('Andor')
    expect(rendered).toContain('downloading')
  })

  it('renders a meter with accessible bounds for gauge-set', () => {
    const rendered = html(
      widgetTile(
        widget({ template: 'gauge-set' }),
        envelope({ projection: { gauges: [{ label: 'Disk', used: 30, total: 120 }] } }),
      ),
    )
    expect(rendered).toContain('role="meter"')
    expect(rendered).toContain('aria-valuenow="25"')
  })

  it('clamps a gauge whose reading exceeds its total', () => {
    // A service reporting used > total is not hypothetical, and a bar wider than its track looks
    // like a rendering bug rather than a data one.
    const rendered = html(
      widgetTile(
        widget({ template: 'gauge-set' }),
        envelope({ projection: { gauges: [{ label: 'Disk', used: 300, total: 120 }] } }),
      ),
    )
    expect(rendered).toContain('aria-valuenow="100"')
    expect(rendered).toContain('width:100.0%')
  })

  it('renders a status pill for status-badge', () => {
    const rendered = html(
      widgetTile(
        widget({ template: 'status-badge' }),
        envelope({ projection: { status: 'down' } }),
      ),
    )
    expect(rendered).toContain('data-neo-status="down"')
  })

  it('renders a link tile as a link before its probe has run', () => {
    const rendered = html(
      widgetTile(
        widget({ template: 'link-tile', title: 'Nextcloud', href: 'http://10.0.0.5:80/' }),
        undefined,
      ),
    )
    expect(rendered).toContain('href="http://10.0.0.5:80/"')
    expect(rendered).toContain('Nextcloud')
  })

  it('keeps the link when the probe failed, and shows the failure in the chip', () => {
    // Most services answer `/` with a redirect to a login page. That is a fact about the probe,
    // not a reason for the bookmark to stop being one.
    const failed = {
      projection: null,
      meta: { fetchedAt: null, ageMs: 0, state: 'error', errorCode: 'redirect' },
    } as unknown as ProjectionEnvelope
    const rendered = html(
      widgetTile(
        widget({ template: 'link-tile', title: 'Nextcloud', href: 'http://10.0.0.5:80/' }),
        failed,
      ),
    )
    expect(rendered).toContain('href="http://10.0.0.5:80/"')
    expect(rendered).toContain('data-neo-chip="error"')
    expect(rendered).toContain('redirect')
  })
})

describe('formatted times', () => {
  it('carries the instant alongside the rendered text, so a static page can rehydrate', () => {
    const rendered = html(
      widgetTile(
        widget({ template: 'stat-grid' }),
        envelope({
          projection: {
            stats: [
              {
                label: 'Airs',
                value: { v: 'in 2 hours', iso: '2026-09-06T14:00:00.000Z', rel: true },
              },
            ],
          },
        } as unknown as Partial<ProjectionEnvelope>),
      ),
    )
    // React serialises the prop as `dateTime`. HTML attribute names are ASCII case-insensitive,
    // so the browser parses it to `datetime` and `el.dateTime` reads correctly — verified in a
    // real browser rather than assumed, which is why the assertion is case-insensitive rather
    // than "fixed" by fighting React's serialisation.
    expect(rendered).toMatch(/datetime="2026-09-06T14:00:00\.000Z"/i)
    expect(rendered).toContain('<time')
    expect(rendered).toContain('in 2 hours')
  })
})

describe('the dashboard shell', () => {
  const resolved = (widgets: ResolvedWidget[]): Resolved =>
    ({
      schemaVersion: 1,
      title: 'Home lab',
      defaultPage: 'home',
      generatedAt: '2026-09-06T12:00:00.000Z',
      pages: [
        { id: 'home', title: 'Home', grid: {}, layouts: {}, widgetIds: widgets.map((w) => w.id) },
      ],
      widgets,
      targets: [],
      theme: {},
      diagnostics: [],
    }) as unknown as Resolved

  it('renders only the widgets on the page being shown', () => {
    const rendered = html(
      dashboard(
        resolved([widget({ id: 'onPage' }), widget({ id: 'elsewhere', page: 'other' })]),
        {},
      ),
    )
    expect(rendered).toContain('data-neo-i="onPage"')
    expect(rendered).not.toContain('data-neo-i="elsewhere"')
  })

  it('says so plainly when there are no pages at all', () => {
    const empty = { ...resolved([]), pages: [] } as unknown as Resolved
    expect(html(dashboard(empty, {}))).toContain('No pages configured yet')
  })
})
