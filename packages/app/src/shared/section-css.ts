import { assertSafeId, emitGridCss, type Breakpoint, type GridConfig } from './grid-css.ts'
import type { ResolvedBookmarksSection, ResolvedGridSection, ResolvedPage } from './resolved.ts'

/**
 * The per-page stylesheet: one absolutely-positioned board per grid section and a column count per
 * bookmarks section, keyed by section id. Emitted by both the publish step and the browser.
 */

function gridConfigOf(section: ResolvedGridSection): GridConfig {
  return {
    breakpoints: section.grid.breakpoints,
    rowHeight: section.grid.rowHeight,
    margin: section.grid.margin,
    containerPadding: section.grid.containerPadding,
  }
}

function boardSelector(sectionId: string): string {
  assertSafeId(sectionId)
  return `.neo-board[data-neo-section="${sectionId}"]`
}

function px(value: number): string {
  return `${String(value)}px`
}

/**
 * `--nh-bm-cols` is read by the base stylesheet into `grid-template-columns`; set mobile-first per
 * breakpoint.
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
      blocks.push(bookmarksRules(section, page.grid.breakpoints))
    }
  }
  return blocks.join('\n')
}
