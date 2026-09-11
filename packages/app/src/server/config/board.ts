import type { LayoutItem } from '../../shared/grid-geometry.ts'
import { fanOut, normaliseLayout, withinMaxRows } from '../../shared/placement.ts'
import { ConfigInvalidError } from '../store/configstore.ts'
import type { MutableConfigTree } from '../store/tree.ts'
import { layoutFileSchema, type Page, type Widget } from './schema.ts'
import { effectiveSections, gridSectionIds, sectionOf } from './sections.ts'

/**
 * The board operations both writers share: the HTTP API behind the editor, and the MCP tools
 * behind an agent. One implementation, so a widget an agent adds lands exactly where one added by
 * hand would, and a layout either can save is bounded by the same section.
 *
 * Everything here works on a transaction draft and throws `ConfigInvalidError` for a caller's
 * mistake — an unknown section, a full board — which the API maps to 422 and a tool to a failure
 * message with the reason in it.
 */

/**
 * The geometry a grid section places into: its own column counts and row cap. The page's layout
 * file is flat, so a section's board is the entries whose widget lives in it; the rest are carried
 * through untouched, which is what makes placing into one section unable to move a tile in another.
 */
export function sectionGeometry(
  page: Page,
  sectionId: string,
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

export function splitBySection(
  items: readonly LayoutItem[],
  widgets: ReadonlyMap<string, Widget>,
  page: Page,
  sectionId: string,
): { mine: LayoutItem[]; others: LayoutItem[] } {
  const mine: LayoutItem[] = []
  const others: LayoutItem[] = []
  for (const item of items) {
    const widget = widgets.get(item.i)
    const owner = widget === undefined ? undefined : sectionOf(widget, page)
    if (owner === sectionId) mine.push(item)
    else others.push(item)
  }
  return { mine, others }
}

function requireGridSection(page: Page, sectionId: string | null | undefined): string {
  const grids = gridSectionIds(page)
  const chosen = sectionId ?? grids[0]
  if (chosen === undefined || !grids.includes(chosen)) {
    throw new ConfigInvalidError([
      { path: `pages/${page.id}.json`, message: `no grid section "${String(chosen)}"` },
    ])
  }
  return chosen
}

/**
 * Place a widget in its section on every authored breakpoint, first-fit, and write the layout.
 *
 * The widget must already be in the draft. Returns the breakpoints that had no room: with a row
 * cap the widget exists but is refused a place there, and saying so beats hiding it.
 */
export function placeWidget(
  draft: MutableConfigTree,
  page: Page,
  widget: Widget,
  size: { w: number; h: number },
): string[] {
  const sectionId = requireGridSection(page, widget.section)
  const existing = draft.layouts.get(page.id)
  const authored = page.grid.breakpoints
    .map((breakpoint) => breakpoint.id)
    .filter((breakpointId) => existing?.meta[breakpointId]?.origin !== 'derived')
  const { cols, maxRows } = sectionGeometry(page, sectionId)

  const split = Object.fromEntries(
    Object.entries(existing?.layouts ?? {}).map(([breakpointId, items]) => [
      breakpointId,
      splitBySection(
        items.filter((item) => item.i !== widget.id),
        draft.widgets,
        page,
        sectionId,
      ),
    ]),
  )
  const { layouts: placed, refused } = fanOut(
    Object.fromEntries(Object.entries(split).map(([key, value]) => [key, value.mine])),
    authored.length > 0 ? authored : [page.grid.authoritative],
    cols,
    maxRows,
    { id: widget.id, w: size.w, h: size.h },
  )
  const layouts = Object.fromEntries(
    [...new Set([...Object.keys(split), ...Object.keys(placed)])].map((breakpointId) => [
      breakpointId,
      [...(split[breakpointId]?.others ?? []), ...(placed[breakpointId] ?? [])],
    ]),
  )

  draft.layouts.set(
    page.id,
    layoutFileSchema.parse({
      page: page.id,
      layouts,
      meta: {
        ...existing?.meta,
        ...Object.fromEntries(
          authored.map((breakpointId) => [
            breakpointId,
            {
              origin: 'authored',
              cols: cols[breakpointId] ?? 12,
              updatedAt: new Date().toISOString(),
            },
          ]),
        ),
      },
    }),
  )
  return refused
}

/**
 * Replace one section's geometry on one breakpoint, leaving every other section's entries as
 * they were. Items that name a widget outside the section are dropped rather than written twice.
 */
export function saveSectionLayout(
  draft: MutableConfigTree,
  page: Page,
  sectionId: string | null | undefined,
  breakpointId: string,
  items: readonly LayoutItem[],
): void {
  const breakpoint = page.grid.breakpoints.find((entry) => entry.id === breakpointId)
  if (breakpoint === undefined) throw new Error(`no breakpoint "${breakpointId}"`)
  const chosen = requireGridSection(page, sectionId)
  const { cols, maxRows } = sectionGeometry(page, chosen)
  const sectionCols = cols[breakpoint.id] ?? breakpoint.cols

  const existing = draft.layouts.get(page.id)
  const { others } = splitBySection(
    existing?.layouts[breakpoint.id] ?? [],
    draft.widgets,
    page,
    chosen,
  )
  const mine = items.filter((item) => {
    const widget = draft.widgets.get(item.i)
    return widget !== undefined && sectionOf(widget, page) === chosen
  })
  const normalised = normaliseLayout(mine, sectionCols)
  if (!withinMaxRows(normalised, maxRows)) {
    throw new ConfigInvalidError([
      {
        path: `layouts/${page.id}.json`,
        message: `layout exceeds the section's ${String(maxRows)}-row limit`,
      },
    ])
  }

  draft.layouts.set(
    page.id,
    layoutFileSchema.parse({
      page: page.id,
      layouts: { ...existing?.layouts, [breakpoint.id]: [...others, ...normalised] },
      meta: {
        ...existing?.meta,
        [breakpoint.id]: {
          origin: 'authored',
          cols: breakpoint.cols,
          updatedAt: new Date().toISOString(),
        },
      },
    }),
  )
}

/** The size a widget currently has on the authoritative tier, for re-placing it elsewhere. */
export function currentSize(
  draft: MutableConfigTree,
  page: Page,
  widgetId: string,
): { w: number; h: number } {
  const item = draft.layouts.get(page.id)?.layouts[page.grid.authoritative]?.find(
    (entry) => entry.i === widgetId,
  )
  return { w: item?.w ?? 4, h: item?.h ?? 3 }
}
