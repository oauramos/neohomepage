import { describe, expect, it } from 'vitest'
import { calcGridItemPosition } from 'react-grid-layout/core'
import {
  emitGridCss,
  expectedCssGeometry,
  UnsafeIdError,
  type Breakpoint,
  type GridConfig,
} from './grid-css.ts'
import type { LayoutItem } from './grid-geometry.ts'

const BREAKPOINTS: Breakpoint[] = [
  { id: 'sm', minWidth: 0, cols: 4 },
  { id: 'md', minWidth: 768, cols: 8 },
  { id: 'lg', minWidth: 1200, cols: 12 },
]

const CONFIG: GridConfig = {
  breakpoints: BREAKPOINTS,
  rowHeight: 56,
  margin: [12, 12],
  containerPadding: [16, 16],
}

const LAYOUTS = {
  sm: [{ i: 'wSonarr', x: 0, y: 0, w: 4, h: 3 }],
  md: [{ i: 'wSonarr', x: 0, y: 0, w: 4, h: 3 }],
  lg: [{ i: 'wSonarr', x: 3, y: 1, w: 4, h: 3 }],
}

describe('emitGridCss', () => {
  it('emits the base breakpoint bare and the rest mobile-first ascending', () => {
    const css = emitGridCss(CONFIG, LAYOUTS)
    const queries = [...css.matchAll(/@media \(min-width:([\d.]+)px\)/g)].map((m) => Number(m[1]))
    expect(queries).toEqual([768, 1200])
    // The base breakpoint stays unwrapped so a browser without media queries still gets a layout.
    expect(css.indexOf('--nh-col')).toBeLessThan(css.indexOf('@media'))
  })

  it('derives the column width from the breakpoint column count', () => {
    const css = emitGridCss(CONFIG, LAYOUTS)
    // sm: 4 cols → gaps = 12*3 + 16*2 = 68
    expect(css).toContain('calc((100% - 68px) / 4)')
    // lg: 12 cols → gaps = 12*11 + 16*2 = 164
    expect(css).toContain('calc((100% - 164px) / 12)')
  })

  it('refuses a widget id that could break out of the selector', () => {
    for (const hostile of ['a"]{color:red}[x', 'has space', '', '../etc', 'a}b']) {
      expect(() => emitGridCss(CONFIG, { sm: [{ i: hostile, x: 0, y: 0, w: 1, h: 1 }] })).toThrow(
        UnsafeIdError,
      )
    }
  })

  it('requires the narrowest breakpoint to start at zero', () => {
    const config = { ...CONFIG, breakpoints: [{ id: 'md', minWidth: 768, cols: 8 }] }
    expect(() => emitGridCss(config, {})).toThrow(/must start at 0/)
  })

  it('gives a breakpoint with no authored layout a height but no items', () => {
    const css = emitGridCss(CONFIG, { sm: LAYOUTS.sm })
    expect(css).toContain('--nh-col')
    expect([...css.matchAll(/data-neo-i="wSonarr"/g)]).toHaveLength(1)
  })
})

describe('CSS geometry against react-grid-layout', () => {
  // The browser lays out calc() in sub-pixels and RGL rounds to integers, so the contract is
  // under one pixel of difference, not bit-identical.
  it('never differs from RGL by a whole pixel, across the parameter space', () => {
    let checked = 0
    let worst = 0
    let worstCase = ''

    for (const containerWidth of [320, 375, 768, 996, 1200, 1440, 1913, 2560]) {
      for (const breakpoint of BREAKPOINTS) {
        for (const mx of [0, 8, 12]) {
          for (const pad of [0, 16]) {
            const config: GridConfig = {
              breakpoints: BREAKPOINTS,
              rowHeight: 56,
              margin: [mx, 12],
              containerPadding: [pad, pad],
            }
            const params = {
              margin: config.margin,
              containerPadding: config.containerPadding,
              containerWidth,
              cols: breakpoint.cols,
              rowHeight: config.rowHeight,
              maxRows: Infinity,
            }
            for (let x = 0; x < breakpoint.cols; x++) {
              for (const w of [1, 2, breakpoint.cols - x].filter(
                (v) => v >= 1 && x + v <= breakpoint.cols,
              )) {
                for (const y of [0, 2]) {
                  for (const h of [1, 3]) {
                    const item: LayoutItem = { i: 'a', x, y, w, h }
                    const rgl = calcGridItemPosition(params, x, y, w, h)
                    const css = expectedCssGeometry(config, breakpoint, item, containerWidth)
                    for (const key of ['left', 'top', 'width', 'height'] as const) {
                      const delta = Math.abs(css[key] - rgl[key])
                      checked++
                      if (delta > worst) {
                        worst = delta
                        worstCase = `${key} at ${JSON.stringify({ containerWidth, cols: breakpoint.cols, mx, pad, x, y, w, h })}: css=${css[key]} rgl=${rgl[key]}`
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(10_000)
    expect(worst, worstCase).toBeLessThan(1)
  })
})
