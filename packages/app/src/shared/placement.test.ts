import { describe, expect, it } from 'vitest'
import type { LayoutItem } from './grid-geometry.ts'
import { fanOut, normaliseLayout, place, withinMaxRows } from './placement.ts'

const item = (i: string, x: number, y: number, w: number, h: number): LayoutItem => ({
  i,
  x,
  y,
  w,
  h,
})

describe('first fit', () => {
  it('puts the first widget at the origin', () => {
    const result = place({ layout: [], cols: 12, maxRows: null, id: 'a', w: 4, h: 3 })
    expect(result.ok && result.item).toEqual(item('a', 0, 0, 4, 3))
  })

  it('fills a gap rather than appending below it', () => {
    const layout = [item('a', 0, 0, 4, 2), item('b', 8, 0, 4, 2)]
    const result = place({ layout, cols: 12, maxRows: null, id: 'c', w: 4, h: 2 })
    expect(result.ok && result.item).toEqual(item('c', 4, 0, 4, 2))
  })

  it('moves to the next row when the current one is full', () => {
    const layout = [item('a', 0, 0, 12, 2)]
    const result = place({ layout, cols: 12, maxRows: null, id: 'b', w: 6, h: 2 })
    expect(result.ok && result.item).toEqual(item('b', 0, 2, 6, 2))
  })

  it('never overlaps an existing widget, over a randomised board', () => {
    let seed = 11
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let layout: LayoutItem[] = []
    for (let n = 0; n < 40; n++) {
      const result = place({
        layout,
        cols: 12,
        maxRows: null,
        id: `w${n}`,
        w: 1 + Math.floor(random() * 5),
        h: 1 + Math.floor(random() * 3),
      })
      expect(result.ok).toBe(true)
      if (result.ok) layout = result.layout
    }
    for (const a of layout) {
      for (const b of layout) {
        if (a.i === b.i) continue
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlaps, `${a.i} overlaps ${b.i}`).toBe(false)
      }
    }
  })

  it('clamps a widget wider than the board instead of leaving it off the edge', () => {
    const result = place({ layout: [], cols: 4, maxRows: null, id: 'a', w: 12, h: 2 })
    expect(result.ok && result.item.w).toBe(4)
    expect(result.ok && result.item.x).toBe(0)
  })

  it('replaces an existing entry for the same id rather than colliding with itself', () => {
    const layout = [item('a', 0, 0, 4, 2)]
    const result = place({ layout, cols: 12, maxRows: null, id: 'a', w: 6, h: 2 })
    expect(result.ok && result.item).toEqual(item('a', 0, 0, 6, 2))
    expect(result.ok && result.layout).toHaveLength(1)
  })

  it('does not mutate the layout it was given', () => {
    const layout = [item('a', 0, 0, 4, 2)]
    const before = JSON.stringify(layout)
    place({ layout, cols: 12, maxRows: null, id: 'b', w: 4, h: 2 })
    expect(JSON.stringify(layout)).toBe(before)
  })
})

describe('maxRows is a real cap', () => {
  it('places inside the limit while there is space', () => {
    const result = place({
      layout: [item('a', 0, 0, 12, 2)],
      cols: 12,
      maxRows: 4,
      id: 'b',
      w: 12,
      h: 2,
    })
    expect(result.ok && result.item.y).toBe(2)
  })

  it('refuses and says why when the canvas is full', () => {
    const layout = [item('a', 0, 0, 12, 4)]
    const result = place({ layout, cols: 12, maxRows: 4, id: 'b', w: 6, h: 2 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/grid is full/)
  })

  it('grows downward without a limit', () => {
    const layout = [item('a', 0, 0, 12, 40)]
    const result = place({ layout, cols: 12, maxRows: null, id: 'b', w: 12, h: 2 })
    expect(result.ok && result.item.y).toBe(40)
  })

  it('validates an existing layout against the limit', () => {
    expect(withinMaxRows([item('a', 0, 0, 2, 3)], 4)).toBe(true)
    expect(withinMaxRows([item('a', 0, 2, 2, 3)], 4)).toBe(false)
    expect(withinMaxRows([item('a', 0, 99, 2, 3)], null)).toBe(true)
  })
})

describe('normalising after an edit', () => {
  it('pulls an out-of-bounds widget back inside the column count', () => {
    expect(normaliseLayout([item('a', 10, 0, 6, 2)], 12)[0]).toMatchObject({ x: 6, w: 6 })
  })

  it('closes vertical gaps', () => {
    const normalised = normaliseLayout([item('a', 0, 5, 4, 2)], 12)
    expect(normalised[0]?.y).toBe(0)
  })

  it('leaves gaps alone when compaction is off', () => {
    expect(normaliseLayout([item('a', 0, 5, 4, 2)], 12, 'none')[0]?.y).toBe(5)
  })

  it('does not mutate its input', () => {
    const layout = [item('a', 10, 5, 6, 2)]
    const before = JSON.stringify(layout)
    normaliseLayout(layout, 12)
    expect(JSON.stringify(layout)).toBe(before)
  })
})

describe('fanning a new widget across breakpoints', () => {
  const cols = { sm: 2, md: 6, lg: 12 }

  it('places it on every authored tier', () => {
    const { layouts, refused } = fanOut(
      { sm: [], md: [], lg: [] },
      ['sm', 'md', 'lg'],
      cols,
      null,
      {
        id: 'a',
        w: 4,
        h: 3,
      },
    )
    expect(refused).toEqual([])
    for (const breakpoint of ['sm', 'md', 'lg']) {
      expect(
        layouts[breakpoint]?.some((entry) => entry.i === 'a'),
        breakpoint,
      ).toBe(true)
    }
  })

  it('narrows the widget to fit a narrow tier rather than dropping it', () => {
    const { layouts } = fanOut({ sm: [] }, ['sm'], cols, null, { id: 'a', w: 8, h: 3 })
    expect(layouts.sm?.[0]?.w).toBe(2)
  })

  it('reports the tiers where it could not fit, rather than silently skipping them', () => {
    const full = [item('x', 0, 0, 2, 4)]
    const { refused } = fanOut({ sm: full }, ['sm'], cols, 4, { id: 'a', w: 2, h: 2 })
    expect(refused).toEqual(['sm'])
  })

  it('leaves unauthored tiers untouched, because they are regenerated from the authoritative one', () => {
    const { layouts } = fanOut({ sm: [], lg: [] }, ['lg'], cols, null, { id: 'a', w: 4, h: 3 })
    expect(layouts.sm).toEqual([])
    expect(layouts.lg).toHaveLength(1)
  })
})
