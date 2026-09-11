/**
 * Column-width and layout-height formulas shared by the view-mode CSS emitter and the
 * react-grid-layout editor, pinned to RGL's `calcGridColWidth` in grid-geometry.test.ts.
 * Pure: no DOM, no Node, no React.
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

/** Width of a single column in px. The formula the CSS emitter mirrors as a calc(). */
export function colWidthPx(
  p: Pick<PositionParams, 'margin' | 'containerPadding' | 'containerWidth' | 'cols'>,
): number {
  return (p.containerWidth - p.margin[0] * (p.cols - 1) - p.containerPadding[0] * 2) / p.cols
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
