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
  iconUrl: null,
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
        {
          id: 'home',
          title: 'Home',
          grid: {},
          sections: [
            { id: 'nav', kind: 'navbar', title: null, items: [{ id: 't', kind: 'title' }] },
            {
              id: 'main',
              kind: 'grid',
              title: null,
              grid: {},
              layouts: {},
              widgetIds: widgets.filter((w) => w.page === 'home').map((w) => w.id),
            },
          ],
          widgetIds: widgets.filter((w) => w.page === 'home').map((w) => w.id),
        },
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

describe('sections', () => {
  const link = (id: string, label: string, href: string, iconUrl: string | null = null) => ({
    id,
    label,
    href,
    icon: null,
    iconUrl,
  })
  const withSections = (sections: unknown[]): Resolved =>
    ({
      schemaVersion: 1,
      title: 'Home lab',
      defaultPage: 'home',
      generatedAt: '2026-09-06T12:00:00.000Z',
      pages: [{ id: 'home', title: 'Home', grid: {}, sections, widgetIds: [] }],
      widgets: [],
      targets: [],
      theme: {},
      diagnostics: [],
    }) as unknown as Resolved

  it('renders every navbar item kind, with the search box as a plain GET form', () => {
    const rendered = html(
      dashboard(
        withSections([
          {
            id: 'nav',
            kind: 'navbar',
            title: null,
            items: [
              { id: 'a', kind: 'title' },
              { id: 'b', kind: 'text', text: 'rack 2' },
              { id: 'c', kind: 'links', links: [link('l', 'NAS', 'http://nas.home/')] },
              { id: 'd', kind: 'spacer' },
              { id: 'e', kind: 'clock', showDate: true, hour12: false },
              { id: 'f', kind: 'search', engine: 'duckduckgo', placeholder: 'Search the web' },
            ],
          },
          { id: 'main', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
        ]),
        {},
        { now: new Date('2026-09-11T15:04:00Z') },
      ),
    )
    expect(rendered).toContain('<h1 class="nh-title">Home lab</h1>')
    expect(rendered).toContain('rack 2')
    expect(rendered).toContain('class="nh-nav-link" href="http://nas.home/"')
    expect(rendered).toContain('class="nh-spacer"')
    expect(rendered).toMatch(/<time class="nh-clock"[^>]*>\d\d:\d\d · [A-Z][a-z]{2} 11 Sep<\/time>/)
    expect(rendered).toContain('action="https://duckduckgo.com/" method="get"')
    expect(rendered).toContain('name="q"')
    expect(rendered).toContain('placeholder="Search the web"')
  })

  it('renders bookmark groups as lists of links, the display on the section', () => {
    const rendered = html(
      dashboard(
        withSections([
          { id: 'main', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
          {
            id: 'links',
            kind: 'bookmarks',
            title: 'Links',
            columns: { sm: 1, md: 2, lg: 3 },
            display: 'chips',
            groups: [
              {
                id: 'router',
                title: 'Router',
                links: [link('l1', 'FriendlyWrt', 'http://192.168.2.1/')],
              },
            ],
          },
        ]),
        {},
      ),
    )
    expect(rendered).toContain(
      'class="nh-section nh-bookmarks" data-neo-section="links" data-neo-display="chips"',
    )
    expect(rendered).toContain('<h2 class="nh-section-title">Links</h2>')
    expect(rendered).toContain('<h3 class="nh-group-title">Router</h3>')
    expect(rendered).toContain('class="nh-bm" href="http://192.168.2.1/"')
    // The glyph is the label's initial until the icon is cached; then it is the image.
    expect(rendered).toContain('aria-hidden="true">F</span>')
  })

  it('draws a cached icon as a decorative image, on links and on tiles', () => {
    const rendered = html(
      dashboard(
        withSections([
          { id: 'main', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
          {
            id: 'links',
            kind: 'bookmarks',
            title: null,
            columns: { sm: 1, md: 2, lg: 3 },
            display: 'icons',
            groups: [
              {
                id: 'g',
                title: 'NAS',
                links: [link('l1', 'Nextcloud', 'http://cloud.home/', '/assets/icons/nextcloud')],
              },
            ],
          },
        ]),
        {},
      ),
    )
    expect(rendered).toContain('<img class="nh-icon" src="/assets/icons/nextcloud" alt=""')
    expect(rendered).not.toContain('aria-hidden="true">N</span>')

    const tile = html(
      widgetTile(widget({ title: 'AdGuard', iconUrl: '/assets/icons/adguard-home' }), undefined),
    )
    expect(tile).toContain('src="/assets/icons/adguard-home"')
    expect(tile).toContain('<h2 id="w1-title" class="nh-tile-title">AdGuard</h2>')
  })

  it('paints a glyph-set icon as a mask in the text colour, or the colour the reference named', () => {
    const rendered = html(
      dashboard(
        withSections([
          { id: 'main', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
          {
            id: 'links',
            kind: 'bookmarks',
            title: null,
            columns: { sm: 1, md: 2, lg: 3 },
            display: 'icons',
            groups: [
              {
                id: 'g',
                title: 'Net',
                links: [
                  {
                    ...link(
                      'l1',
                      'Router',
                      'http://192.168.1.254/',
                      '/assets/icons/mdi-router-network',
                    ),
                    iconMode: 'mask',
                  },
                  {
                    ...link(
                      'l2',
                      'Mi',
                      'http://192.168.2.101/',
                      '/assets/icons/mdi-router-wireless-ff6900',
                    ),
                    iconMode: 'mask',
                    iconColor: '#ff6900',
                  },
                ],
              },
            ],
          },
        ]),
        {},
      ),
    )
    expect(rendered).toContain(
      'class="nh-icon nh-icon-mask" aria-hidden="true" style="--nh-icon-url:url(&quot;/assets/icons/mdi-router-network&quot;)"',
    )
    expect(rendered).toContain('--nh-icon-color:#ff6900')
    expect(rendered).not.toContain('src="/assets/icons/mdi-router-network"')
  })

  it('keeps one header landmark and one main, with later navbars inside main', () => {
    const rendered = html(
      dashboard(
        withSections([
          { id: 'nav', kind: 'navbar', title: null, items: [{ id: 'a', kind: 'title' }] },
          { id: 'main', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
          {
            id: 'nav2',
            kind: 'navbar',
            title: null,
            items: [{ id: 'b', kind: 'text', text: 'lower' }],
          },
        ]),
        {},
      ),
    )
    expect(rendered.indexOf('<header')).toBeLessThan(rendered.indexOf('<main'))
    expect(rendered.match(/<main/g)).toHaveLength(1)
    expect(rendered.indexOf('lower')).toBeGreaterThan(rendered.indexOf('<main'))
  })

  it('shows the first-run hint only on the first grid, and only when the page is empty', () => {
    const empty = html(
      dashboard(
        withSections([
          { id: 'a', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
          { id: 'b', kind: 'grid', title: null, grid: {}, layouts: {}, widgetIds: [] },
        ]),
        {},
      ),
    )
    expect(empty.match(/No widgets yet/g)).toHaveLength(1)
  })
})
