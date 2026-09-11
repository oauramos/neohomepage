import { sectionSchema, type Page, type Section, type Widget } from './schema.ts'

/**
 * The sections a page has, whether or not it declares any.
 *
 * A page with an empty `sections` is every page that existed before sections did: a header
 * carrying the title over one grid. Materialising that pair here — once, for the resolver, the
 * validator and the write API alike — is what lets those files stay untouched on disk while
 * every consumer sees one shape.
 */
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
 * Which grid section a widget sits in.
 *
 * `null` — the value every widget written before sections existed carries — means the first
 * grid section, so an old config lands where it always did. A section id that is not a grid
 * section on the page is refused by the validator; this only has to answer for valid trees.
 */
export function sectionOf(widget: Widget, page: Page): string | undefined {
  const grids = gridSectionIds(page)
  if (widget.section !== null && grids.includes(widget.section)) return widget.section
  return grids[0]
}
