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
    const page = r.pages[0]
    expect(page?.layouts.lg).toHaveLength(1)
    expect(page?.layouts.md).toHaveLength(1)
    expect(page?.layouts.sm).toHaveLength(1)
    expect(page?.layouts.sm?.[0]?.w).toBeLessThanOrEqual(2)
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
    expect(r.pages[0]?.layouts.sm?.[0]?.h).toBe(9)
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
    expect(r.pages[0]?.layouts.lg).toEqual([])
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
