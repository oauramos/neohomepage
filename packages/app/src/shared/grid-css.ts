import { colWidthPx, layoutHeightPx, type LayoutItem } from './grid-geometry.ts'

/**
 * Emits the stylesheet that positions the board in view mode, with no grid library on the page.
 * The server has no measured container width, so it emits grid-geometry.ts's column formula as a
 * calc(); the result matches RGL's integer pixels to within one pixel, not bit-exactly.
 */

export type Breakpoint = {
  readonly id: string
  /** Inclusive lower bound in px. Exactly one breakpoint must use 0. */
  readonly minWidth: number
  readonly cols: number
}

export type GridConfig = {
  readonly breakpoints: readonly Breakpoint[]
  readonly rowHeight: number
  readonly margin: readonly [number, number]
  readonly containerPadding: readonly [number, number]
}

export type BreakpointLayouts = Readonly<Record<string, readonly LayoutItem[]>>

// Ids come from agent- or import-written config and are interpolated into a selector. Refused
// rather than escaped: generated ids always fit this shape, so a violation is a bug or an attack.
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export class UnsafeIdError extends Error {
  constructor(id: string) {
    super(`id is not safe to place in a CSS selector: ${JSON.stringify(id)}`)
    this.name = 'UnsafeIdError'
  }
}

export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new UnsafeIdError(id)
}

/** Round to 4 decimals so the output is stable and diffable rather than full float noise. */
function px(value: number): string {
  return `${Math.round(value * 10000) / 10000}px`
}

function breakpointRules(
  config: GridConfig,
  breakpoint: Breakpoint,
  layout: readonly LayoutItem[],
  boardSelector: string,
): string {
  const [mx, my] = config.margin
  const [padX, padY] = config.containerPadding
  const fixedGaps = mx * (breakpoint.cols - 1) + padX * 2

  const rules = [
    `${boardSelector}{--nh-col:calc((100% - ${px(fixedGaps)}) / ${breakpoint.cols});` +
      `height:${px(layoutHeightPx(config, layout))}}`,
  ]

  for (const item of layout) {
    assertSafeId(item.i)
    const left = `calc((var(--nh-col) + ${px(mx)}) * ${item.x} + ${px(padX)})`
    const width = `calc(var(--nh-col) * ${item.w} + ${px(Math.max(0, item.w - 1) * mx)})`
    const top = px((config.rowHeight + my) * item.y + padY)
    const height = px(config.rowHeight * item.h + Math.max(0, item.h - 1) * my)
    rules.push(
      `${boardSelector}>[data-neo-i="${item.i}"]{left:${left};top:${top};width:${width};height:${height}}`,
    )
  }
  return rules.join('\n')
}

export function emitGridCss(
  config: GridConfig,
  layouts: BreakpointLayouts,
  boardSelector = '.neo-board',
): string {
  if (config.breakpoints.length === 0) throw new Error('a grid needs at least one breakpoint')

  // Mobile-first: ascending minWidth so a wider breakpoint's rules override a narrower one's.
  const ordered = [...config.breakpoints].sort((a, b) => a.minWidth - b.minWidth)
  const base = ordered[0] as Breakpoint
  if (base.minWidth !== 0) {
    throw new Error(`the narrowest breakpoint must start at 0, got ${base.minWidth}`)
  }

  const blocks = [
    `${boardSelector}{position:relative;box-sizing:border-box}`,
    `${boardSelector}>[data-neo-i]{position:absolute;box-sizing:border-box}`,
    breakpointRules(config, base, layouts[base.id] ?? [], boardSelector),
  ]

  for (const breakpoint of ordered.slice(1)) {
    const rules = breakpointRules(config, breakpoint, layouts[breakpoint.id] ?? [], boardSelector)
    blocks.push(`@media (min-width:${px(breakpoint.minWidth)}){\n${rules}\n}`)
  }

  return blocks.join('\n')
}

/** The px geometry a browser should compute from the emitted CSS, for the parity test. */
export function expectedCssGeometry(
  config: GridConfig,
  breakpoint: Breakpoint,
  item: LayoutItem,
  containerWidth: number,
): { left: number; top: number; width: number; height: number } {
  const [mx, my] = config.margin
  const [padX, padY] = config.containerPadding
  const col = colWidthPx({
    margin: config.margin,
    containerPadding: config.containerPadding,
    containerWidth,
    cols: breakpoint.cols,
  })
  return {
    left: (col + mx) * item.x + padX,
    top: (config.rowHeight + my) * item.y + padY,
    width: col * item.w + Math.max(0, item.w - 1) * mx,
    height: config.rowHeight * item.h + Math.max(0, item.h - 1) * my,
  }
}
