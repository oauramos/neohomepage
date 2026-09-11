import { assertSafeId, emitGridCss, type Breakpoint, type GridConfig } from './grid-css.ts'
import type { ResolvedBookmarksSection, ResolvedGridSection, ResolvedPage } from './resolved.ts'

/**
 * The per-page stylesheet: one absolutely-positioned board per grid section, and a column count
 * per bookmarks section, each keyed by the section's id.
 *
 * Emitted by the publish step into the document and by the browser into a `<style>` it owns, from
 * the same resolved page — which is what keeps a section added in the editor laid out before the
 * next publish, rather than stacked at the top-left until a reload.
 */

export function gridConfigOf(section: ResolvedGridSection): GridConfig {
  return {
    breakpoints: section.grid.breakpoints as readonly Breakpoint[],
    rowHeight: section.grid.rowHeight,
    margin: section.grid.margin,
    containerPadding: section.grid.containerPadding,
  }
}

export function boardSelector(sectionId: string): string {
  assertSafeId(sectionId)
  return `.neo-board[data-neo-section="${sectionId}"]`
}

function px(value: number): string {
  return `${String(value)}px`
}

/**
 * Groups per row is a custom property the base stylesheet reads into `grid-template-columns`, set
 * mobile-first per breakpoint so the section follows the same tiers the boards do.
 */
function bookmarksRules(
  section: ResolvedBookmarksSection,
  breakpoints: readonly Breakpoint[],
): string {
  assertSafeId(section.id)
  const selector = `.nh-bookmarks[data-neo-section="${section.id}"]`
  const ordered = [...breakpoints].sort((a, b) => a.minWidth - b.minWidth)
  return ordered
    .map((breakpoint) => {
      const rule = `${selector}{--nh-bm-cols:${String(section.columns[breakpoint.id] ?? 1)}}`
      return breakpoint.minWidth === 0
        ? rule
        : `@media (min-width:${px(breakpoint.minWidth)}){${rule}}`
    })
    .join('\n')
}

export function emitPageCss(page: ResolvedPage): string {
  const blocks: string[] = []
  for (const section of page.sections) {
    if (section.kind === 'grid') {
      blocks.push(emitGridCss(gridConfigOf(section), section.layouts, boardSelector(section.id)))
    } else if (section.kind === 'bookmarks') {
      blocks.push(bookmarksRules(section, page.grid.breakpoints as readonly Breakpoint[]))
    }
  }
  return blocks.join('\n')
}
