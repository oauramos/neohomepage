import { sectionSchema, type Page, type Section, type Widget } from './schema.ts'

/** A page's sections; an empty `sections` means the pre-sections default of a title header over one grid. */
export function effectiveSections(page: Page): readonly Section[] {
  if (page.sections.length > 0) return page.sections
  return [
    sectionSchema.parse({ id: 'nav', kind: 'navbar', items: [{ id: 'title', kind: 'title' }] }),
    sectionSchema.parse({ id: 'main', kind: 'grid' }),
  ]
}

export function gridSectionIds(page: Page): readonly string[] {
  return effectiveSections(page)
    .filter((section) => section.kind === 'grid')
    .map((section) => section.id)
}

/**
 * Grid section a widget sits in; `null` (every pre-sections widget) means the first grid section.
 * A section id that is not a grid section is refused by the validator, so the fallback only ever
 * serves an invalid tree.
 */
export function sectionOf(widget: Widget, page: Page): string | undefined {
  const grids = gridSectionIds(page)
  if (widget.section !== null && grids.includes(widget.section)) return widget.section
  return grids[0]
}

/** Column counts and row cap of one grid section, falling back to the page's grid. */
export function sectionGeometry(
  page: Page,
  sectionId: string | undefined,
): { cols: Record<string, number>; maxRows: number | null } {
  const section = effectiveSections(page).find(
    (candidate) => candidate.id === sectionId && candidate.kind === 'grid',
  )
  const cols = Object.fromEntries(
    page.grid.breakpoints.map((breakpoint) => [
      breakpoint.id,
      section?.kind === 'grid' ? (section.cols[breakpoint.id] ?? breakpoint.cols) : breakpoint.cols,
    ]),
  )
  const maxRows =
    section?.kind === 'grid' ? (section.maxRows ?? page.grid.maxRows) : page.grid.maxRows
  return { cols, maxRows }
}
