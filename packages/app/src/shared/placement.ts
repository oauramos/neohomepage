import { cloneLayout, correctBounds, getCompactor } from 'react-grid-layout/core'
import type { LayoutItem } from './grid-geometry.ts'

/**
 * Where a new widget goes.
 *
 * Shared by the editor and the MCP tools on purpose: a widget an agent adds must land exactly
 * where one added by hand would. Two placement implementations would mean "the AI put it
 * somewhere strange", which is unfalsifiable and unfixable.
 *
 * `correctBounds` mutates its argument — verified against react-grid-layout 2.2.4 — so every entry
 * point here clones first. Without that, placing a widget would rewrite the caller's layout array
 * in place.
 */

export type PlacementRequest = {
  readonly layout: readonly LayoutItem[]
  readonly cols: number
  /** null means the board grows downward; a number makes it a fixed canvas. */
  readonly maxRows: number | null
  readonly id: string
  readonly w: number
  readonly h: number
}

export type PlacementResult =
  | { readonly ok: true; readonly item: LayoutItem; readonly layout: LayoutItem[] }
  | { readonly ok: false; readonly reason: string }

function collides(a: LayoutItem, b: LayoutItem): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

function fits(layout: readonly LayoutItem[], candidate: LayoutItem): boolean {
  return !layout.some((existing) => existing.i !== candidate.i && collides(existing, candidate))
}

/**
 * First fit, scanning left to right then top to bottom.
 *
 * Deliberately not "append at the bottom": a board with a gap in the middle and a new widget
 * parked below the fold looks broken, and the gap is usually exactly where the user expected the
 * thing to appear.
 */
export function place(request: PlacementRequest): PlacementResult {
  const width = Math.max(1, Math.min(request.cols, request.w))
  const height = Math.max(1, request.h)

  if (width > request.cols) {
    return {
      ok: false,
      reason: `a widget ${request.w} columns wide does not fit in ${request.cols}`,
    }
  }

  const occupied = request.layout.filter((item) => item.i !== request.id)
  const bottom = occupied.reduce((max, item) => Math.max(max, item.y + item.h), 0)
  const searchRows = request.maxRows ?? bottom + height + 1

  for (let y = 0; y + height <= searchRows; y++) {
    for (let x = 0; x + width <= request.cols; x++) {
      const candidate: LayoutItem = { i: request.id, x, y, w: width, h: height }
      if (fits(occupied, candidate)) {
        return { ok: true, item: candidate, layout: [...occupied, candidate] }
      }
    }
  }

  // Only reachable with maxRows set. Refusing, and saying why, is the whole point of that
  // setting: on a wall display a widget pushed below the fold is a widget that does not exist.
  return {
    ok: false,
    reason:
      `the grid is full: ${request.cols} columns by ${String(request.maxRows)} rows leaves no ` +
      `space for a ${width}x${height} widget`,
  }
}

/** Normalise a layout after an edit: clamp into the column count, then close vertical gaps. */
export function normaliseLayout(
  layout: readonly LayoutItem[],
  cols: number,
  compaction: 'vertical' | 'none' = 'vertical',
): LayoutItem[] {
  const bounded = correctBounds(cloneLayout([...layout]), { cols })
  if (compaction === 'none') return bounded as LayoutItem[]
  return getCompactor('vertical').compact(bounded, cols) as LayoutItem[]
}

/** Does every item fit inside the page's row limit? */
export function withinMaxRows(layout: readonly LayoutItem[], maxRows: number | null): boolean {
  if (maxRows === null) return true
  return layout.every((item) => item.y + item.h <= maxRows)
}

/**
 * Fan a placement out to the breakpoints nobody has authored.
 *
 * A widget that exists at one width and not another is invisible on a phone with no error, which
 * reads as data loss. Derived tiers are regenerated wholesale from the authoritative one, so this
 * only has to add the item where a tier IS authored.
 */
export function fanOut(
  layouts: Readonly<Record<string, readonly LayoutItem[]>>,
  authored: readonly string[],
  cols: Readonly<Record<string, number>>,
  maxRows: number | null,
  item: { id: string; w: number; h: number },
): { layouts: Record<string, LayoutItem[]>; refused: string[] } {
  const out: Record<string, LayoutItem[]> = {}
  const refused: string[] = []

  for (const [breakpoint, existing] of Object.entries(layouts)) {
    out[breakpoint] = [...existing]
  }

  for (const breakpoint of authored) {
    const columns = cols[breakpoint] ?? 12
    const result = place({
      layout: out[breakpoint] ?? [],
      cols: columns,
      maxRows,
      id: item.id,
      w: Math.min(item.w, columns),
      h: item.h,
    })
    if (result.ok) out[breakpoint] = result.layout
    else refused.push(breakpoint)
  }

  return { layouts: out, refused }
}
