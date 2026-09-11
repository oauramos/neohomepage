import { describe, expect, it } from 'vitest'
import {
  dashboardSchema,
  layoutFileSchema,
  pageSchema,
  themeSchema,
  networkSchema,
  widgetSchema,
} from '../config/schema.ts'
import { treeRevision, validateTree, type ConfigTree } from './tree.ts'

function tree(overrides: Partial<{ [K in keyof ConfigTree]: ConfigTree[K] }> = {}): ConfigTree {
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

describe('a valid tree', () => {
  it('has no problems', () => {
    expect(validateTree(tree())).toEqual([])
  })
})

describe('revision', () => {
  it('is stable across map insertion order', () => {
    const a = tree({
      widgets: new Map([
        ['a', widget('a')],
        ['b', widget('b')],
      ]),
    })
    const b = tree({
      widgets: new Map([
        ['b', widget('b')],
        ['a', widget('a')],
      ]),
    })
    expect(treeRevision(a)).toBe(treeRevision(b))
  })

  it('changes when any content changes', () => {
    const before = treeRevision(tree())
    const after = treeRevision(tree({ widgets: new Map([['a', widget('a')]]) }))
    expect(after).not.toBe(before)
  })
})

describe('cross-file invariants', () => {
  it('catches a page listed in dashboard.json with no file', () => {
    const t = tree({
      dashboard: dashboardSchema.parse({ schemaVersion: 1, pages: ['home', 'media'] }),
    })
    expect(validateTree(t).map((p) => p.message)).toContain('page "media" has no pages/media.json')
  })

  it('catches a default page that is not in the page list', () => {
    const t = tree({
      dashboard: dashboardSchema.parse({ schemaVersion: 1, defaultPage: 'gone', pages: ['home'] }),
    })
    expect(validateTree(t).some((p) => p.path === 'dashboard.defaultPage')).toBe(true)
  })

  it('catches a widget on a page that does not exist', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { page: 'nowhere' })]]) })
    expect(validateTree(t).map((p) => p.message)).toContain('page "nowhere" does not exist')
  })

  it('catches a widget pointing at a deleted target', () => {
    const t = tree({ widgets: new Map([['w1', widget('w1', { targetId: 'tGone' })]]) })
    expect(validateTree(t).map((p) => p.message)).toContain('target "tGone" does not exist')
  })

  it('catches a file whose id disagrees with its name', () => {
    const t = tree({ widgets: new Map([['w1', widget('other')]]) })
    expect(validateTree(t).some((p) => p.message.includes('but the file is w1.json'))).toBe(true)
  })

  it('catches an orphaned layout entry, which is otherwise a ghost in the editor', () => {
    const t = tree({
      layouts: new Map([
        [
          'home',
          layoutFileSchema.parse({
            page: 'home',
            layouts: { lg: [{ i: 'wGone', x: 0, y: 0, w: 2, h: 2 }] },
          }),
        ],
      ]),
    })
    expect(validateTree(t).some((p) => p.message.includes('which is not on this page'))).toBe(true)
  })

  it('catches the same widget placed twice in one breakpoint', () => {
    const t = tree({
      widgets: new Map([['w1', widget('w1')]]),
      layouts: new Map([
        [
          'home',
          layoutFileSchema.parse({
            page: 'home',
            layouts: {
              lg: [
                { i: 'w1', x: 0, y: 0, w: 2, h: 2 },
                { i: 'w1', x: 4, y: 0, w: 2, h: 2 },
              ],
            },
          }),
        ],
      ]),
    })
    expect(validateTree(t).some((p) => p.message.includes('appears twice'))).toBe(true)
  })

  it('catches a widget spanning past the column count of its breakpoint', () => {
    const t = tree({
      widgets: new Map([['w1', widget('w1')]]),
      layouts: new Map([
        [
          'home',
          layoutFileSchema.parse({
            page: 'home',
            layouts: { sm: [{ i: 'w1', x: 1, y: 0, w: 4, h: 2 }] },
          }),
        ],
      ]),
    })
    // sm is 2 columns wide by default; x=1 w=4 runs off the end.
    expect(validateTree(t).some((p) => p.message.includes('spans past column 2'))).toBe(true)
  })

  it('enforces maxRows as a real cap rather than a decorative field', () => {
    const page = pageSchema.parse({ id: 'home', grid: { maxRows: 4 } })
    const t = tree({
      pages: new Map([['home', page]]),
      widgets: new Map([['w1', widget('w1')]]),
      layouts: new Map([
        [
          'home',
          layoutFileSchema.parse({
            page: 'home',
            layouts: { lg: [{ i: 'w1', x: 0, y: 3, w: 2, h: 3 }] },
          }),
        ],
      ]),
    })
    expect(validateTree(t).some((p) => p.message.includes('4-row limit'))).toBe(true)
  })

  it('catches a breakpoint set with no zero-width tier', () => {
    const page = pageSchema.parse({
      id: 'home',
      grid: { authoritative: 'lg', breakpoints: [{ id: 'lg', minWidth: 1200, cols: 12 }] },
    })
    expect(
      validateTree(tree({ pages: new Map([['home', page]]) })).some((p) =>
        p.message.includes('minWidth 0'),
      ),
    ).toBe(true)
  })

  it('catches two breakpoints sharing a minWidth, where precedence is undefined', () => {
    const page = pageSchema.parse({
      id: 'home',
      grid: {
        authoritative: 'a',
        breakpoints: [
          { id: 'a', minWidth: 0, cols: 4 },
          { id: 'b', minWidth: 0, cols: 6 },
        ],
      },
    })
    expect(
      validateTree(tree({ pages: new Map([['home', page]]) })).some((p) =>
        p.message.includes('share minWidth 0'),
      ),
    ).toBe(true)
  })

  it('catches an authoritative breakpoint that is not defined', () => {
    const page = pageSchema.parse({ id: 'home', grid: { authoritative: 'xl' } })
    expect(
      validateTree(tree({ pages: new Map([['home', page]]) })).some((p) =>
        p.message.includes('authoritative breakpoint "xl"'),
      ),
    ).toBe(true)
  })
})

describe('sections', () => {
  const sectioned = (sections: unknown[]) =>
    new Map([['home', pageSchema.parse({ id: 'home', sections })]])
  const messages = (t: ConfigTree) => validateTree(t).map((p) => p.message)

  it('accepts a page that declares none, and one that declares the usual pair', () => {
    expect(validateTree(tree())).toEqual([])
    const t = tree({
      pages: sectioned([
        { id: 'nav', kind: 'navbar', items: [{ id: 't', kind: 'title' }] },
        { id: 'main', kind: 'grid' },
      ]),
    })
    expect(validateTree(t)).toEqual([])
  })

  it('catches a widget naming a section that is not a grid on its page', () => {
    const t = tree({
      pages: sectioned([
        { id: 'main', kind: 'grid' },
        { id: 'links', kind: 'bookmarks' },
      ]),
      widgets: new Map([
        ['w1', widget('w1', { section: 'links' })],
        ['w2', widget('w2', { section: 'ghost' })],
      ]),
    })
    expect(messages(t)).toEqual([
      expect.stringContaining('section "links" is not a grid section'),
      expect.stringContaining('section "ghost" is not a grid section'),
    ])
  })

  it('catches duplicate ids among sections, groups, links and navbar items', () => {
    const t = tree({
      pages: sectioned([
        { id: 'main', kind: 'grid' },
        {
          id: 'main',
          kind: 'bookmarks',
          groups: [
            { id: 'g', title: 'A' },
            { id: 'g', title: 'B' },
          ],
        },
        {
          id: 'nav',
          kind: 'navbar',
          items: [
            { id: 'x', kind: 'title' },
            { id: 'x', kind: 'spacer' },
          ],
        },
      ]),
    })
    expect(messages(t)).toEqual([
      expect.stringContaining('section "main" is declared twice'),
      expect.stringContaining('group "g" is declared twice'),
      expect.stringContaining('navbar item "x" is declared twice'),
    ])
  })

  it('refuses a page whose declared sections leave widgets nowhere to go', () => {
    const t = tree({ pages: sectioned([{ id: 'links', kind: 'bookmarks' }]) })
    expect(messages(t)).toEqual([expect.stringContaining('at least one grid section')])
  })

  it('catches a section sizing a breakpoint the page does not have', () => {
    const t = tree({ pages: sectioned([{ id: 'main', kind: 'grid', cols: { xl: 16 } }]) })
    expect(messages(t)).toEqual([expect.stringContaining('breakpoint "xl"')])
  })

  it("bounds a layout entry by its section's columns and row cap, not the page's", () => {
    const t = tree({
      pages: sectioned([
        { id: 'main', kind: 'grid' },
        { id: 'narrow', kind: 'grid', cols: { lg: 6 }, maxRows: 2 },
      ]),
      widgets: new Map([
        ['wide', widget('wide')],
        ['tight', widget('tight', { section: 'narrow' })],
      ]),
      layouts: new Map([
        [
          'home',
          layoutFileSchema.parse({
            page: 'home',
            layouts: {
              lg: [
                // Fine on the 12-column main section.
                { i: 'wide', x: 4, y: 0, w: 8, h: 3 },
                // The same geometry in the six-column, two-row section breaks both bounds.
                { i: 'tight', x: 4, y: 0, w: 8, h: 3 },
              ],
            },
          }),
        ],
      ]),
    })
    expect(messages(t)).toEqual([
      expect.stringContaining('"tight" spans past column 6'),
      expect.stringContaining('"tight" exceeds the 2-row limit'),
    ])
  })
})
