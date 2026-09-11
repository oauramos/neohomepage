import { describe, expect, it } from 'vitest'
import { manifestSchema, type Manifest } from '@neohomepage/catalog-schema'
import {
  dashboardSchema,
  layoutFileSchema,
  networkSchema,
  pageSchema,
  targetSchema,
  themeSchema,
  widgetSchema,
} from '../config/schema.ts'
import { overridesSchema } from '../config/overrides.ts'
import type { ConfigTree } from '../store/tree.ts'
import { deriveLayout, resolve } from './resolve.ts'

const NOW = '2026-09-06T12:00:00.000Z'

const MANIFEST: Manifest = manifestSchema.parse({
  manifestVersion: 1,
  id: 'sonarr-queue',
  version: '1.0.0',
  displayName: 'Sonarr queue',
  category: 'media-automation',
  icon: 'sonarr',
  target: { fields: [], auth: { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' } },
  config: [{ name: 'maxItems', kind: 'integer', label: 'Items', default: 5 }],
  operations: { queue: { method: 'GET', path: '/api/v3/queue' } },
  projection: { op: 'const', value: {} },
  presentation: { template: 'list' },
  poll: { defaultIntervalMs: 60000, minIntervalMs: 15000 },
  requires: {
    templates: ['list'],
    opcodes: ['const'],
    authKinds: ['header'],
    fetchKinds: ['json'],
  },
})

const CATALOG = new Map([['sonarr-queue', MANIFEST]])

function tree(overrides: Partial<ConfigTree> = {}): ConfigTree {
  return {
    dashboard: dashboardSchema.parse({ schemaVersion: 1 }),
    theme: themeSchema.parse({}),
    network: networkSchema.parse({}),
    pages: new Map([['home', pageSchema.parse({ id: 'home' })]]),
    layouts: new Map(),
    targets: new Map(),
    widgets: new Map(),
    ...overrides,
  }
}

const widget = (id: string, extra: Record<string, unknown> = {}) =>
  widgetSchema.parse({ id, page: 'home', type: 'sonarr-queue', ...extra })

/** The first grid section of the first page — where every pre-sections config puts its widgets. */
const mainGrid = (r: ReturnType<typeof resolve>) => {
  const section = r.pages[0]?.sections.find((candidate) => candidate.kind === 'grid')
  if (section === undefined || section.kind !== 'grid') throw new Error('no grid section')
  return section
}

describe('purity', () => {
  it('produces byte-identical output for identical input', () => {
    const input = {
      tree: tree({ widgets: new Map([['w1', widget('w1')]]) }),
      catalog: CATALOG,
      generatedAt: NOW,
    }
    expect(JSON.stringify(resolve(input))).toBe(JSON.stringify(resolve(input)))
  })

  it('does not mutate the config it was given', () => {
    const layouts = new Map([
      [
        'home',
        layoutFileSchema.parse({
          page: 'home',
          layouts: { lg: [{ i: 'w1', x: 8, y: 0, w: 4, h: 3 }] },
        }),
      ],
    ])
    const t = tree({ widgets: new Map([['w1', widget('w1')]]), layouts })
    const before = JSON.stringify([...t.layouts])
    resolve({ tree: t, catalog: CATALOG, generatedAt: NOW })
    // correctBounds mutates its argument; without cloneLayout this assertion fails and the next
    // save would persist machine-derived geometry into a git-tracked file.
    expect(JSON.stringify([...t.layouts])).toBe(before)
  })

  it('sorts widgets and targets by id, so output does not depend on map order', () => {
    const a = resolve({
      tree: tree({
        widgets: new Map([
          ['wB', widget('wB')],
          ['wA', widget('wA')],
        ]),
      }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    expect(a.widgets.map((w) => w.id)).toEqual(['wA', 'wB'])
  })
})

describe('precedence layers', () => {
  it('takes manifest defaults when the user set nothing', () => {
    const r = resolve({
      tree: tree({ widgets: new Map([['w1', widget('w1')]]) }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    expect(r.widgets[0]?.config).toEqual({ maxItems: 5 })
  })

  it('lets user config beat the manifest default', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { config: { maxItems: 12 } })]]) })
    expect(resolve({ tree: t, catalog: CATALOG, generatedAt: NOW }).widgets[0]?.config).toEqual({
      maxItems: 12,
    })
  })

  it('lets a local override beat user config', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { config: { maxItems: 12 } })]]) })
    const overrides = overridesSchema.parse({ widgets: { w1: { config: { maxItems: 3 } } } })
    expect(
      resolve({ tree: t, catalog: CATALOG, overrides, generatedAt: NOW }).widgets[0]?.config,
    ).toEqual({
      maxItems: 3,
    })
  })

  it('lets a local override relocate a target without touching the shared config', () => {
    // The laptop-versus-NAS case: the same repository, a different address for the same service.
    const target = targetSchema.parse({
      id: 'tSonarr',
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { host: '10.0.0.20', port: 8989 },
    })
    const t = tree({ targets: new Map([['tSonarr', target]]) })
    const overrides = overridesSchema.parse({
      targets: { tSonarr: { base: { host: 'localhost' } } },
    })
    const r = resolve({ tree: t, catalog: CATALOG, overrides, generatedAt: NOW })
    expect(r.targets[0]?.origin).toBe('http://localhost:8989')
    expect(target.base.host).toBe('10.0.0.20')
  })
})

describe('a bookmark href', () => {
  const LINK: Manifest = manifestSchema.parse({
    ...MANIFEST,
    id: 'service-link',
    kind: 'bookmark',
    config: [
      { name: 'label', kind: 'string', label: 'Label', required: true },
      { name: 'path', kind: 'string', label: 'Path', default: '/' },
    ],
    presentation: { template: 'link-tile' },
    requires: { ...MANIFEST.requires, templates: ['link-tile'] },
  })
  const catalog = new Map([...CATALOG, ['service-link', LINK]])
  const target = targetSchema.parse({
    id: 'tCloud',
    label: 'Nextcloud',
    widgetType: 'service-link',
    base: { scheme: 'https', host: 'cloud.home', port: 443 },
  })
  const link = (config: Record<string, unknown>) =>
    widgetSchema.parse({ id: 'w1', page: 'home', type: 'service-link', targetId: 'tCloud', config })

  it('is the bound target plus the configured path, resolved before any probe has run', () => {
    const t = tree({
      targets: new Map([['tCloud', target]]),
      widgets: new Map([['w1', link({ path: '/apps/files' })]]),
    })
    expect(resolve({ tree: t, catalog, generatedAt: NOW }).widgets[0]?.href).toBe(
      'https://cloud.home:443/apps/files',
    )
  })

  it('follows a relocated target, so the laptop and the NAS get different links', () => {
    const t = tree({ targets: new Map([['tCloud', target]]), widgets: new Map([['w1', link({})]]) })
    const overrides = overridesSchema.parse({
      targets: { tCloud: { base: { host: 'localhost' } } },
    })
    expect(resolve({ tree: t, catalog, overrides, generatedAt: NOW }).widgets[0]?.href).toBe(
      'https://localhost:443/',
    )
  })

  it('refuses the same paths the targetUrl opcode refuses', () => {
    for (const path of ['/../etc', '//evil.example']) {
      const t = tree({
        targets: new Map([['tCloud', target]]),
        widgets: new Map([['w1', link({ path })]]),
      })
      expect(resolve({ tree: t, catalog, generatedAt: NOW }).widgets[0]?.href).toBeNull()
    }
  })

  it('is null for a widget that is a reading rather than a bookmark', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1')]]) })
    expect(resolve({ tree: t, catalog, generatedAt: NOW }).widgets[0]?.href).toBeNull()
  })
})

describe('polling intervals', () => {
  it('never polls faster than the manifest says the service tolerates', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { poll: { intervalMs: 1000 } })]]) })
    expect(
      resolve({ tree: t, catalog: CATALOG, generatedAt: NOW }).widgets[0]?.pollIntervalMs,
    ).toBe(15000)
  })

  it('honours a slower interval the user chose', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { poll: { intervalMs: 300000 } })]]) })
    expect(
      resolve({ tree: t, catalog: CATALOG, generatedAt: NOW }).widgets[0]?.pollIntervalMs,
    ).toBe(300000)
  })
})

describe('a widget type missing from the catalog', () => {
  it('renders as a placeholder rather than disappearing, and says so', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { type: 'not-in-catalog' })]]) })
    const r = resolve({ tree: t, catalog: CATALOG, generatedAt: NOW })
    expect(r.widgets[0]?.unsupported).toBe(true)
    expect(r.diagnostics.some((d) => d.includes('not in the catalog'))).toBe(true)
  })
})

describe('layout derivation', () => {
  it('scales a wide layout down to fewer columns and keeps everything in bounds', () => {
    const authored = [
      { i: 'a', x: 0, y: 0, w: 6, h: 2 },
      { i: 'b', x: 6, y: 0, w: 6, h: 2 },
    ]
    const derived = deriveLayout(authored, 12, 6)
    expect(derived).toHaveLength(2)
    for (const item of derived) {
      expect(item.x).toBeGreaterThanOrEqual(0)
      expect(item.x + item.w).toBeLessThanOrEqual(6)
    }
  })

  it('never produces a zero-width item, however narrow the target', () => {
    // A 1-column tier scaling a 1-of-12 widget rounds to 0 without the clamp, and RGL then
    // silently creates a 1x1 nobody asked for.
    const derived = deriveLayout([{ i: 'a', x: 11, y: 0, w: 1, h: 2 }], 12, 1)
    expect(derived[0]?.w).toBe(1)
    expect(derived[0]?.x).toBe(0)
  })

  it('derives the other breakpoints from the authoritative one', () => {
    const layouts = new Map([
      [
        'home',
        layoutFileSchema.parse({
          page: 'home',
          layouts: { lg: [{ i: 'w1', x: 0, y: 0, w: 6, h: 3 }] },
          meta: { lg: { origin: 'authored', cols: 12 } },
        }),
      ],
    ])
    const r = resolve({
      tree: tree({ widgets: new Map([['w1', widget('w1')]]), layouts }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    const grid = mainGrid(r)
    expect(grid.layouts.lg).toHaveLength(1)
    expect(grid.layouts.md).toHaveLength(1)
    expect(grid.layouts.sm).toHaveLength(1)
    expect(grid.layouts.sm?.[0]?.w).toBeLessThanOrEqual(2)
  })

  it('keeps an authored narrow layout instead of overwriting it with a derived one', () => {
    const layouts = new Map([
      [
        'home',
        layoutFileSchema.parse({
          page: 'home',
          layouts: {
            lg: [{ i: 'w1', x: 0, y: 0, w: 6, h: 3 }],
            sm: [{ i: 'w1', x: 0, y: 0, w: 2, h: 9 }],
          },
          meta: { lg: { origin: 'authored', cols: 12 }, sm: { origin: 'authored', cols: 2 } },
        }),
      ],
    ])
    const r = resolve({
      tree: tree({ widgets: new Map([['w1', widget('w1')]]), layouts }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    expect(mainGrid(r).layouts.sm?.[0]?.h).toBe(9)
  })

  it('drops layout entries for widgets that no longer exist', () => {
    const layouts = new Map([
      [
        'home',
        layoutFileSchema.parse({
          page: 'home',
          layouts: { lg: [{ i: 'gone', x: 0, y: 0, w: 2, h: 2 }] },
          meta: { lg: { origin: 'authored', cols: 12 } },
        }),
      ],
    ])
    const r = resolve({ tree: tree({ layouts }), catalog: CATALOG, generatedAt: NOW })
    expect(mainGrid(r).layouts.lg).toEqual([])
  })

  it('reports a widget that has no placement anywhere', () => {
    const r = resolve({
      tree: tree({ widgets: new Map([['w1', widget('w1')]]) }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    expect(r.diagnostics.some((d) => d.includes('no layout entry'))).toBe(true)
  })
})

describe('sections', () => {
  const layoutsFor = (
    items: Record<string, { i: string; x: number; y: number; w: number; h: number }[]>,
  ) =>
    new Map([
      [
        'home',
        layoutFileSchema.parse({
          page: 'home',
          layouts: items,
          meta: Object.fromEntries(
            Object.keys(items).map((bp) => [bp, { origin: 'authored', cols: 12 }]),
          ),
        }),
      ],
    ])

  it('gives a page that declares none the header-over-one-grid it always had', () => {
    const r = resolve({ tree: tree(), catalog: CATALOG, generatedAt: NOW })
    expect(r.pages[0]?.sections.map((s) => s.kind)).toEqual(['navbar', 'grid'])
    const nav = r.pages[0]?.sections[0]
    expect(nav?.kind === 'navbar' && nav.items.map((i) => i.kind)).toEqual(['title'])
  })

  it('slices the flat layout file per grid section, each board starting at row zero', () => {
    const page = pageSchema.parse({
      id: 'home',
      sections: [
        { id: 'top', kind: 'grid' },
        { id: 'bottom', kind: 'grid', cols: { lg: 6 } },
      ],
    })
    const t = tree({
      pages: new Map([['home', page]]),
      widgets: new Map([
        ['w1', widget('w1')],
        ['w2', widget('w2', { section: 'bottom' })],
      ]),
      layouts: layoutsFor({
        lg: [
          { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
          { i: 'w2', x: 0, y: 0, w: 4, h: 3 },
        ],
      }),
    })
    const r = resolve({ tree: t, catalog: CATALOG, generatedAt: NOW })
    // Declared sections replace the implicit pair wholesale: no navbar unless one is listed.
    const [top, bottom] = r.pages[0]?.sections ?? []
    expect(top?.kind === 'grid' && top.widgetIds).toEqual(['w1'])
    expect(bottom?.kind === 'grid' && bottom.widgetIds).toEqual(['w2'])
    expect(top?.kind === 'grid' && top.layouts.lg?.map((i) => i.i)).toEqual(['w1'])
    expect(bottom?.kind === 'grid' && bottom.layouts.lg?.map((i) => i.i)).toEqual(['w2'])
    // The narrower section derives its other tiers from ITS column count, not the page's.
    expect(
      bottom?.kind === 'grid' && bottom.grid.breakpoints.find((b) => b.id === 'lg')?.cols,
    ).toBe(6)
    expect(r.diagnostics).toEqual([])
  })

  it('composes a bookmark href from its parts and drops a default port', () => {
    const page = pageSchema.parse({
      id: 'home',
      sections: [
        { id: 'main', kind: 'grid' },
        {
          id: 'links',
          kind: 'bookmarks',
          columns: { lg: 3 },
          groups: [
            {
              id: 'g1',
              title: 'Router',
              links: [
                { id: 'l1', label: 'FriendlyWrt', base: { host: '192.168.2.1', port: 80 } },
                {
                  id: 'l2',
                  label: 'Tailscale',
                  base: { scheme: 'https', host: 'login.tailscale.com', port: 443 },
                  path: '/admin/',
                },
                { id: 'l3', label: 'Proxy', base: { host: '10.0.0.5', port: 81 } },
              ],
            },
          ],
        },
      ],
    })
    const r = resolve({
      tree: tree({ pages: new Map([['home', page]]) }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    const section = r.pages[0]?.sections[1]
    if (section?.kind !== 'bookmarks') throw new Error('expected a bookmarks section')
    expect(section.groups[0]?.links.map((l) => l.href)).toEqual([
      'http://192.168.2.1/',
      'https://login.tailscale.com/admin/',
      'http://10.0.0.5:81/',
    ])
    // Dense: every breakpoint gets a column count, the unspecified ones from the grid's width.
    expect(section.columns).toEqual({ sm: 1, md: 2, lg: 3 })
  })

  it('resolves navbar links and passes the other items through', () => {
    const page = pageSchema.parse({
      id: 'home',
      sections: [
        {
          id: 'nav',
          kind: 'navbar',
          items: [
            { id: 'a', kind: 'title' },
            {
              id: 'b',
              kind: 'links',
              links: [{ id: 'l', label: 'NAS', base: { host: 'nas.home', port: 80 } }],
            },
            { id: 'c', kind: 'clock' },
            { id: 'd', kind: 'search', engine: 'google' },
          ],
        },
        { id: 'main', kind: 'grid' },
      ],
    })
    const r = resolve({
      tree: tree({ pages: new Map([['home', page]]) }),
      catalog: CATALOG,
      generatedAt: NOW,
    })
    const nav = r.pages[0]?.sections[0]
    if (nav?.kind !== 'navbar') throw new Error('expected a navbar')
    expect(nav.items.map((i) => i.kind)).toEqual(['title', 'links', 'clock', 'search'])
    const links = nav.items[1]
    expect(links?.kind === 'links' && links.links[0]?.href).toBe('http://nas.home/')
  })
})
