import { describe, expect, it } from 'vitest'
import { calcGridColWidth } from 'react-grid-layout/core'
import { colWidthPx, layoutHeightPx, type PositionParams } from './grid-geometry.ts'

/**
 * Sweeps the parameter space so the column-width formula matches RGL's `calcGridColWidth`
 * exactly; grid-css.test.ts holds the emitted calc() geometry to within a pixel. Together they
 * pin the RGL version: a release that changes either formula turns one of them red.
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
})

describe('layoutHeightPx', () => {
  const p = { margin: [12, 12] as const, containerPadding: [16, 16] as const, rowHeight: 56 }

  it('reserves only the padding for an empty board', () => {
    expect(layoutHeightPx(p, [])).toBe(32)
  })

  it('measures to the bottom of the lowest item, not the item count', () => {
    const layout = [
      { i: 'a', x: 0, y: 0, w: 1, h: 1 },
      { i: 'b', x: 1, y: 4, w: 1, h: 2 },
    ]
    // rows = 6 → 56*6 + 12*5 + 16*2
    expect(layoutHeightPx(p, layout)).toBe(56 * 6 + 12 * 5 + 32)
  })
})
