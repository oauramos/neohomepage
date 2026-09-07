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
  }

  for (const [id, widget] of tree.widgets) {
    if (widget.id !== id) {
      problems.push({
        path: `widgets/${id}.json`,
        message: `id is "${widget.id}" but the file is ${id}.json`,
      })
    }
    if (!tree.pages.has(widget.page)) {
      problems.push({ path: `widgets/${id}.json`, message: `page "${widget.page}" does not exist` })
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
    const pageWidgets = new Set(
      [...tree.widgets.values()].filter((w) => w.page === pageId).map((w) => w.id),
    )

    for (const [breakpointId, items] of Object.entries(layout.layouts)) {
      if (!breakpointIds.has(breakpointId)) {
        problems.push({
          path: `layouts/${pageId}.json`,
          message: `breakpoint "${breakpointId}" is not defined on the page`,
        })
        continue
      }
      const cols = page.grid.breakpoints.find((b) => b.id === breakpointId)?.cols ?? 0
      const placed = new Set<string>()
      for (const item of items) {
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
        if (page.grid.maxRows !== null && item.y + item.h > page.grid.maxRows) {
          problems.push({
            path: `layouts/${pageId}.json`,
            message: `widget "${item.i}" exceeds the page's ${page.grid.maxRows}-row limit`,
          })
        }
      }
    }
  }

  return problems
}
