import { describe, expect, it } from 'vitest'
import { calcGridItemPosition, calcGridColWidth } from 'react-grid-layout/core'
import { colWidthPx, itemPositionPx, layoutHeightPx, type PositionParams } from './grid-geometry.ts'

/**
 * The parity test. View mode renders from our geometry with no grid library on the page; edit
 * mode renders from react-grid-layout. If the two disagree, the board jumps the moment the editor
 * opens — so this sweeps the real parameter space and asserts bit-identical agreement rather than
 * spot-checking a few golden values.
 *
 * It also pins us to a specific RGL version by construction: if a future release changes the
 * sub-pixel correction, this goes red and the emitter has to be updated with it.
 */

const WIDTHS = [320, 375, 414, 768, 996, 1200, 1440, 1913, 2560]
const COLS = [1, 2, 3, 4, 6, 8, 10, 12, 16]
const MARGINS_X = [0, 8, 12, 16]
const MARGINS_Y = [0, 10, 12]
const PADDINGS = [0, 12, 16]
const ROW_HEIGHTS = [40, 56, 100]

function* parameterSweep(): Generator<PositionParams> {
  for (const containerWidth of WIDTHS)
    for (const cols of COLS)
      for (const mx of MARGINS_X)
        for (const my of MARGINS_Y)
          for (const px of PADDINGS)
            for (const rowHeight of ROW_HEIGHTS)
              yield {
                margin: [mx, my],
                containerPadding: [px, px],
                containerWidth,
                cols,
                rowHeight,
                maxRows: Infinity,
              }
}

describe('grid geometry parity with react-grid-layout', () => {
  it('matches calcGridColWidth exactly', () => {
    for (const p of parameterSweep()) {
      expect(colWidthPx(p)).toBe(calcGridColWidth(p))
    }
  })

  it('matches calcGridItemPosition exactly across the parameter space', () => {
    let checked = 0
    const mismatches: string[] = []

    for (const p of parameterSweep()) {
      for (let x = 0; x < p.cols; x++) {
        const spans = [...new Set([1, 2, p.cols - x])].filter((w) => w >= 1 && x + w <= p.cols)
        for (const w of spans) {
          for (const y of [0, 1, 3, 17]) {
            for (const h of [1, 2, 4]) {
              const expected = calcGridItemPosition(p, x, y, w, h)
              const actual = itemPositionPx(p, { x, y, w, h })
              checked++
              if (
                actual.top !== expected.top ||
                actual.left !== expected.left ||
                actual.width !== expected.width ||
                actual.height !== expected.height
              ) {
                if (mismatches.length < 5) {
                  mismatches.push(
                    `${JSON.stringify({ ...p, x, y, w, h })}: ` +
                      `rgl=${JSON.stringify(expected)} ours=${JSON.stringify(actual)}`,
                  )
                }
              }
            }
          }
        }
      }
    }

    // Guard the guard: a sweep that silently shrank to a handful of cases would pass vacuously.
    expect(checked).toBeGreaterThan(100_000)
    expect(mismatches).toEqual([])
  })

  it('reproduces the sub-pixel correction that keeps adjacent items abutting', () => {
    // The case that a naive `round(colWidth * w + (w-1) * margin)` gets wrong: at 375px across
    // 6 columns the exact column width is fractional, and only edge-rounding keeps the gap right.
    const p: PositionParams = {
      margin: [0, 0],
      containerPadding: [16, 16],
      containerWidth: 375,
      cols: 6,
      rowHeight: 40,
      maxRows: Infinity,
    }
    const naive = Math.round(colWidthPx(p))
    const actual = itemPositionPx(p, { x: 2, y: 0, w: 1, h: 1 })
    expect(actual.width).not.toBe(naive)
    expect(actual.width).toBe(calcGridItemPosition(p, 2, 0, 1, 1).width)

    // And the invariant the correction exists to preserve: with a zero margin, item N+1 starts
    // exactly where item N ends, for every column.
    for (let x = 0; x + 1 < p.cols; x++) {
      const a = itemPositionPx(p, { x, y: 0, w: 1, h: 1 })
      const b = itemPositionPx(p, { x: x + 1, y: 0, w: 1, h: 1 })
      expect(a.left + a.width).toBe(b.left)
    }
  })
})

describe('layoutHeightPx', () => {
  const p = { margin: [12, 12] as const, containerPadding: [16, 16] as const, rowHeight: 56 }

  it('reserves only the padding for an empty board', () => {
    expect(layoutHeightPx(p, [])).toBe(32)
  })

  it('measures to the bottom of the lowest item, not the item count', () => {
    // Two items, but one sits at y=4: height must follow position, not cardinality.
    const layout = [
      { i: 'a', x: 0, y: 0, w: 1, h: 1 },
      { i: 'b', x: 1, y: 4, w: 1, h: 2 },
    ]
    // rows = 6 → 56*6 + 12*5 + 16*2
    expect(layoutHeightPx(p, layout)).toBe(56 * 6 + 12 * 5 + 32)
  })
})
