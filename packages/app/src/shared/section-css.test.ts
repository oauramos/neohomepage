import { describe, expect, it } from 'vitest'
import { emitPageCss } from './section-css.ts'
import type { ResolvedPage } from './resolved.ts'

const GRID = {
  rowHeight: 56,
  margin: [12, 12] as [number, number],
  containerPadding: [16, 16] as [number, number],
  maxRows: null,
  breakpoints: [
    { id: 'sm', minWidth: 0, cols: 2 },
    { id: 'md', minWidth: 768, cols: 6 },
    { id: 'lg', minWidth: 1200, cols: 12 },
  ],
  authoritative: 'lg',
}

const page: ResolvedPage = {
  id: 'home',
  title: 'Home',
  grid: GRID,
  widgetIds: ['w1', 'w2'],
  sections: [
    { id: 'nav', kind: 'navbar', title: null, items: [{ id: 't', kind: 'title', boxed: false }] },
    {
      id: 'main',
      kind: 'grid',
      title: null,
      grid: GRID,
      layouts: { sm: [{ i: 'w1', x: 0, y: 0, w: 2, h: 3 }] },
      widgetIds: ['w1'],
    },
    {
      id: 'narrow',
      kind: 'grid',
      title: 'Side',
      grid: {
        ...GRID,
        breakpoints: [
          { id: 'sm', minWidth: 0, cols: 2 },
          { id: 'md', minWidth: 768, cols: 3 },
          { id: 'lg', minWidth: 1200, cols: 6 },
        ],
      },
      layouts: { sm: [{ i: 'w2', x: 0, y: 0, w: 2, h: 3 }] },
      widgetIds: ['w2'],
    },
    {
      id: 'links',
      kind: 'bookmarks',
      title: null,
      columns: { sm: 1, md: 2, lg: 4 },
      display: 'list',
      groups: [],
    },
  ],
}

describe('the page stylesheet', () => {
  const css = emitPageCss(page)

  it('positions each grid section under its own selector, so two boards never share rules', () => {
    expect(css).toContain('.neo-board[data-neo-section="main"]>[data-neo-i="w1"]')
    expect(css).toContain('.neo-board[data-neo-section="narrow"]>[data-neo-i="w2"]')
    expect(css).not.toContain('.neo-board[data-neo-section="main"]>[data-neo-i="w2"]')
  })

  it("uses the section's own column count, not the page's", () => {
    // Each grid section emits its own media blocks; match the lg rule of each.
    expect(css).toMatch(
      /\.neo-board\[data-neo-section="narrow"\]\{--nh-col:calc\(\(100% - \d+px\) \/ 6\)/,
    )
    expect(css).toMatch(
      /\.neo-board\[data-neo-section="main"\]\{--nh-col:calc\(\(100% - \d+px\) \/ 12\)/,
    )
  })

  it('sets bookmark columns mobile-first per breakpoint', () => {
    expect(css).toContain('.nh-bookmarks[data-neo-section="links"]{--nh-bm-cols:1}')
    expect(css).toContain(
      '@media (min-width:768px){.nh-bookmarks[data-neo-section="links"]{--nh-bm-cols:2}}',
    )
    expect(css).toContain(
      '@media (min-width:1200px){.nh-bookmarks[data-neo-section="links"]{--nh-bm-cols:4}}',
    )
  })

  it('emits nothing for a navbar', () => {
    expect(css).not.toContain('"nav"')
  })

  it('refuses a section id that could escape a selector', () => {
    const evil = {
      ...page,
      sections: [{ ...page.sections[3], id: 'x"]{}' }],
    } as unknown as ResolvedPage
    expect(() => emitPageCss(evil)).toThrow(/not safe/)
  })
})
