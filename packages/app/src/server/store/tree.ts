import { createHash } from 'node:crypto'
import type {
  Dashboard,
  LayoutFile,
  Network,
  Page,
  Target,
  Theme,
  Widget,
} from '../config/schema.ts'
import { effectiveSections, gridSectionIds, sectionOf } from '../config/sections.ts'

/**
 * The whole config tree in memory.
 *
 * Every mutation validates the *entire prospective tree*, not just the file being written. Almost
 * every interesting invariant is cross-file — a layout entry pointing at a deleted widget, a
 * widget pointing at a target that no longer exists — and per-file validation cannot see any of
 * them.
 */
export type ConfigTree = {
  readonly dashboard: Dashboard
  readonly theme: Theme
  readonly network: Network
  readonly pages: ReadonlyMap<string, Page>
  readonly layouts: ReadonlyMap<string, LayoutFile>
  readonly targets: ReadonlyMap<string, Target>
  readonly widgets: ReadonlyMap<string, Widget>
}

export type MutableConfigTree = {
  dashboard: Dashboard
  theme: Theme
  network: Network
  pages: Map<string, Page>
  layouts: Map<string, LayoutFile>
  targets: Map<string, Target>
  widgets: Map<string, Widget>
}

export function toMutable(tree: ConfigTree): MutableConfigTree {
  return {
    dashboard: structuredClone(tree.dashboard),
    theme: structuredClone(tree.theme),
    network: structuredClone(tree.network),
    pages: new Map(structuredClone([...tree.pages])),
    layouts: new Map(structuredClone([...tree.layouts])),
    targets: new Map(structuredClone([...tree.targets])),
    widgets: new Map(structuredClone([...tree.widgets])),
  }
}

/**
 * A content revision for optimistic concurrency. The browser sends it back as `If-Match` and an
 * MCP agent as `baseRevision`; a mismatch is a 409 telling the caller to re-read rather than
 * clobber. Sorted map entries so the hash depends on content, never on insertion order.
 */
export function treeRevision(tree: ConfigTree): string {
  const sorted = (map: ReadonlyMap<string, unknown>) =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'en-US'))
  const material = JSON.stringify([
    tree.dashboard,
    tree.theme,
    tree.network,
    sorted(tree.pages),
    sorted(tree.layouts),
    sorted(tree.targets),
    sorted(tree.widgets),
  ])
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

export type Problem = { readonly path: string; readonly message: string }

/**
 * Cross-file invariants. Everything here is a state the UI, an importer or an MCP agent could
 * otherwise produce, and every one of them renders as a blank tile or a crash rather than an
 * error message if it reaches disk.
 */
export function validateTree(tree: ConfigTree): Problem[] {
  const problems: Problem[] = []

  for (const pageId of tree.dashboard.pages) {
    if (!tree.pages.has(pageId)) {
      problems.push({
        path: 'dashboard.pages',
        message: `page "${pageId}" has no pages/${pageId}.json`,
      })
    }
  }
  if (!tree.dashboard.pages.includes(tree.dashboard.defaultPage)) {
    problems.push({
      path: 'dashboard.defaultPage',
      message: `"${tree.dashboard.defaultPage}" is not in dashboard.pages`,
    })
  }

  for (const [id, page] of tree.pages) {
    if (page.id !== id) {
      problems.push({
        path: `pages/${id}.json`,
        message: `id is "${page.id}" but the file is ${id}.json`,
      })
    }
    const breakpointIds = new Set(page.grid.breakpoints.map((b) => b.id))
    if (!breakpointIds.has(page.grid.authoritative)) {
      problems.push({
        path: `pages/${id}.json`,
        message: `authoritative breakpoint "${page.grid.authoritative}" is not one of the page's breakpoints`,
      })
    }
    if (!page.grid.breakpoints.some((b) => b.minWidth === 0)) {
      problems.push({
        path: `pages/${id}.json`,
        // Without a zero-width tier the narrowest screens get no rules at all and the board
        // collapses into a single column stack with no positioning.
        message: 'the narrowest breakpoint must start at minWidth 0',
      })
    }
    const seen = new Set<number>()
    for (const breakpoint of page.grid.breakpoints) {
      if (seen.has(breakpoint.minWidth)) {
        problems.push({
          path: `pages/${id}.json`,
          message: `two breakpoints share minWidth ${breakpoint.minWidth}; which one wins is undefined`,
        })
      }
      seen.add(breakpoint.minWidth)
    }

    // Section, group, link and navbar item ids all end up in CSS selectors and React keys, and a
    // duplicate is a tile drawn twice or a group that cannot be addressed for removal.
    const sectionIds = new Set<string>()
    for (const section of page.sections) {
      if (sectionIds.has(section.id)) {
        problems.push({
          path: `pages/${id}.json`,
          message: `section "${section.id}" is declared twice`,
        })
      }
      sectionIds.add(section.id)
      const unique = (scope: string, ids: readonly string[]) => {
        const found = new Set<string>()
        for (const entry of ids) {
          if (found.has(entry)) {
            problems.push({
              path: `pages/${id}.json`,
              message: `${scope} "${entry}" is declared twice in section "${section.id}"`,
            })
          }
          found.add(entry)
        }
      }
      if (section.kind === 'navbar') {
        unique(
          'navbar item',
          section.items.map((item) => item.id),
        )
        for (const item of section.items) {
          if (item.kind === 'links')
            unique(
              'link',
              item.links.map((link) => link.id),
            )
        }
      }
      if (section.kind === 'bookmarks') {
        unique(
          'group',
          section.groups.map((group) => group.id),
        )
        for (const group of section.groups)
          unique(
            'link',
            group.links.map((link) => link.id),
          )
      }
      const breakpointKeys =
        section.kind === 'grid'
          ? Object.keys(section.cols)
          : section.kind === 'bookmarks'
            ? Object.keys(section.columns)
            : []
      for (const key of breakpointKeys) {
        if (!breakpointIds.has(key)) {
          problems.push({
            path: `pages/${id}.json`,
            message: `section "${section.id}" sizes breakpoint "${key}", which the page does not define`,
          })
        }
      }
    }
    if (page.sections.length > 0 && gridSectionIds(page).length === 0) {
      problems.push({
        path: `pages/${id}.json`,
        // Widgets need somewhere to be; a page of only bookmarks is fine until one is added.
        message: 'a page that declares sections needs at least one grid section',
      })
    }
  }

  for (const [id, widget] of tree.widgets) {
    if (widget.id !== id) {
      problems.push({
        path: `widgets/${id}.json`,
        message: `id is "${widget.id}" but the file is ${id}.json`,
      })
    }
    const page = tree.pages.get(widget.page)
    if (page === undefined) {
      problems.push({ path: `widgets/${id}.json`, message: `page "${widget.page}" does not exist` })
    } else if (widget.section !== null && !gridSectionIds(page).includes(widget.section)) {
      problems.push({
        path: `widgets/${id}.json`,
        message: `section "${widget.section}" is not a grid section of page "${widget.page}"`,
      })
    }
    if (widget.targetId !== null && !tree.targets.has(widget.targetId)) {
      problems.push({
        path: `widgets/${id}.json`,
        message: `target "${widget.targetId}" does not exist`,
      })
    }
  }

  for (const [pageId, layout] of tree.layouts) {
    const page = tree.pages.get(pageId)
    if (page === undefined) {
      problems.push({ path: `layouts/${pageId}.json`, message: `no page "${pageId}"` })
      continue
    }
    const breakpointIds = new Set(page.grid.breakpoints.map((b) => b.id))
    const pageWidgets = new Map(
      [...tree.widgets.values()].filter((w) => w.page === pageId).map((w) => [w.id, w]),
    )
    // A grid section may narrow the page's columns or cap its rows; the bounds are the section's.
    const sections = new Map(
      effectiveSections(page)
        .filter((section) => section.kind === 'grid')
        .map((section) => [section.id, section]),
    )
    const boundsOf = (widgetId: string, breakpointId: string) => {
      const widget = pageWidgets.get(widgetId)
      const section = widget === undefined ? undefined : sections.get(sectionOf(widget, page) ?? '')
      const pageCols = page.grid.breakpoints.find((b) => b.id === breakpointId)?.cols ?? 0
      return {
        cols: section?.kind === 'grid' ? (section.cols[breakpointId] ?? pageCols) : pageCols,
        maxRows:
          section?.kind === 'grid' ? (section.maxRows ?? page.grid.maxRows) : page.grid.maxRows,
      }
    }

    for (const [breakpointId, items] of Object.entries(layout.layouts)) {
      if (!breakpointIds.has(breakpointId)) {
        problems.push({
          path: `layouts/${pageId}.json`,
          message: `breakpoint "${breakpointId}" is not defined on the page`,
        })
        continue
      }
      const placed = new Set<string>()
      for (const item of items) {
        const { cols, maxRows } = boundsOf(item.i, breakpointId)
        if (!pageWidgets.has(item.i)) {
          problems.push({
            path: `layouts/${pageId}.json`,
            // An orphaned entry is invisible until someone opens the editor and finds a ghost.
            message: `layout ${breakpointId} references widget "${item.i}", which is not on this page`,
          })
        }
        if (placed.has(item.i)) {
          problems.push({
            path: `layouts/${pageId}.json`,
            message: `widget "${item.i}" appears twice in breakpoint ${breakpointId}`,
          })
        }
        placed.add(item.i)
        if (item.x + item.w > cols) {
          problems.push({
            path: `layouts/${pageId}.json`,
            message: `widget "${item.i}" spans past column ${cols} in breakpoint ${breakpointId}`,
          })
        }
        if (maxRows !== null && item.y + item.h > maxRows) {
          problems.push({
            path: `layouts/${pageId}.json`,
            message: `widget "${item.i}" exceeds the ${maxRows}-row limit of its section`,
          })
        }
      }
    }
  }

  return problems
}
