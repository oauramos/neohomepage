/**
 * The one layout model, expressed twice.
 *
 * View mode is static HTML with no grid library on the page; edit mode mounts react-grid-layout.
 * Two renderers for one model is the most damaging bug class this project has — the board would
 * visibly jump the moment you open the editor — so the geometry lives here, is a faithful copy of
 * RGL's own algorithm (including its sub-pixel correction), and is verified against the real
 * library over an exhaustive sweep in grid-geometry.test.ts.
 *
 * Pure: no DOM, no Node, no React. Imported by the publish step and by the editor alike.
 */

export type LayoutItem = {
  readonly i: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type PositionParams = {
  /** [horizontal, vertical] gap between items, in px. */
  readonly margin: readonly [number, number]
  /** [horizontal, vertical] padding inside the container, in px. */
  readonly containerPadding: readonly [number, number]
  readonly containerWidth: number
  readonly cols: number
  readonly rowHeight: number
  readonly maxRows: number
}

export type Position = {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/** Width of a single column in px. The formula the CSS emitter mirrors as a calc(). */
export function colWidthPx(
  p: Pick<PositionParams, 'margin' | 'containerPadding' | 'containerWidth' | 'cols'>,
): number {
  return (p.containerWidth - p.margin[0] * (p.cols - 1) - p.containerPadding[0] * 2) / p.cols
}

function spanPx(units: number, unitSize: number, marginPx: number): number {
  if (!Number.isFinite(units)) return units
  return Math.round(unitSize * units + Math.max(0, units - 1) * marginPx)
}

/**
 * Pixel geometry of one item, bit-identical to RGL's calcGridItemPosition.
 *
 * The correction blocks are the subtle part: after rounding each edge independently, RGL nudges
 * the span so the gap to where the *next* item starts is exactly one margin. Without it, rounding
 * error accumulates across a row and adjacent cards drift apart by a pixel at some widths.
 */
export function itemPositionPx(
  p: PositionParams,
  item: Pick<LayoutItem, 'x' | 'y' | 'w' | 'h'>,
): Position {
  const { margin, containerPadding, rowHeight } = p
  const colWidth = colWidthPx(p)

  let width = spanPx(item.w, colWidth, margin[0])
  let height = spanPx(item.h, rowHeight, margin[1])
  const top = Math.round((rowHeight + margin[1]) * item.y + containerPadding[1])
  const left = Math.round((colWidth + margin[0]) * item.x + containerPadding[0])

  if (Number.isFinite(item.w)) {
    const siblingLeft = Math.round((colWidth + margin[0]) * (item.x + item.w) + containerPadding[0])
    const actualMarginRight = siblingLeft - left - width
    if (actualMarginRight !== margin[0]) width += actualMarginRight - margin[0]
  }
  if (Number.isFinite(item.h)) {
    const siblingTop = Math.round((rowHeight + margin[1]) * (item.y + item.h) + containerPadding[1])
    const actualMarginBottom = siblingTop - top - height
    if (actualMarginBottom !== margin[1]) height += actualMarginBottom - margin[1]
  }

  return { top, left, width, height }
}

/** Total content height in px for a layout — what the container must reserve. */
export function layoutHeightPx(
  p: Pick<PositionParams, 'margin' | 'containerPadding' | 'rowHeight'>,
  layout: readonly LayoutItem[],
): number {
  const rows = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0)
  if (rows === 0) return p.containerPadding[1] * 2
  return Math.round(
    p.rowHeight * rows + Math.max(0, rows - 1) * p.margin[1] + p.containerPadding[1] * 2,
  )
}
