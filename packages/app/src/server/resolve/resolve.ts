import { cloneLayout, correctBounds, getCompactor } from 'react-grid-layout/core'
import type { Manifest } from '@neohomepage/catalog-schema'
import { isComposite } from '@neohomepage/catalog-schema'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import type { BookmarkLink, NavItem, Page, Section, Target, Widget } from '../config/schema.ts'
import { effectiveSections, sectionOf } from '../config/sections.ts'
import { composeHref } from '../../shared/links.ts'
import { iconKey, iconMode, parseIconRef } from '../assets/icons.ts'
import type { Overrides } from '../config/overrides.ts'
import { EMPTY_OVERRIDES } from '../config/overrides.ts'
import type { ConfigTree } from '../store/tree.ts'

/**
 * The compiler.
 *
 * Sparse declarations on disk become one dense, fully-evaluated tree. This is the idea worth
 * stealing from NixOS: the files hold only what the user chose, the schema and the widget
 * manifests hold the defaults, and a single pure function produces the thing everything else
 * reads. Nothing downstream — the renderer, the scheduler, the API — ever has to ask "was this
 * set, or is it a default?"
 *
 * Four layers, lowest precedence first:
 *   1. manifest defaults      what the widget's author declared
 *   2. discovered             reserved and empty; Docker label discovery slots in here later
 *   3. user config            config/*.json, what the UI and MCP write
 *   4. local overrides        config/overrides.local.json, gitignored and machine-specific
 *
 * Pure: no clock, no filesystem, no network. `generatedAt` is passed in so two runs over the same
 * inputs produce byte-identical output, which is what lets the publish step skip a no-op render.
 */

import type {
  Resolved,
  ResolvedLink,
  ResolvedNavItem,
  ResolvedPage,
  ResolvedSection,
  ResolvedTarget,
  ResolvedWidget,
} from '../../shared/resolved.ts'

export type { Resolved, ResolvedPage, ResolvedTarget, ResolvedWidget }

export type ResolveInput = {
  readonly tree: ConfigTree
  readonly catalog: ReadonlyMap<string, Manifest>
  readonly overrides?: Overrides
  /** Icon slugs with a cached file. Absent means no icon renders as an image — the glyph does. */
  readonly icons?: ReadonlySet<string>
  readonly generatedAt: string
}

/** Where a cached icon is served from. The store names the file; this only has to agree on the key. */
function iconUrl(
  reference: string | null | undefined,
  icons: ReadonlySet<string> | undefined,
): string | null {
  if (reference === null || reference === undefined || icons === undefined) return null
  const ref = parseIconRef(reference)
  if (ref === null) return null
  const key = iconKey(ref)
  return icons.has(key) ? `/assets/icons/${key}` : null
}

function manifestDefaults(manifest: Manifest | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const field of manifest?.config ?? []) {
    if (field.default !== undefined) defaults[field.name] = field.default
  }
  return defaults
}

/**
 * A bookmark's destination, built the way the `targetUrl` opcode builds a deep link: the bound
 * target's origin, then a path that must be absolute and free of `..` and `//`. The same two
 * rules, so a link tile cannot say anything about a target that its projection could not.
 */
function linkHref(
  template: string,
  config: Record<string, unknown>,
  target: ResolvedTarget | undefined,
): string | null {
  if (template !== 'link-tile' || target === undefined) return null
  const raw = typeof config.path === 'string' ? config.path : '/'
  const path = raw.startsWith('/') ? raw : `/${raw}`
  if (path.includes('..') || path.includes('//')) return null
  return `${target.origin}${path}`
}

function resolveWidget(
  widget: Widget,
  catalog: ReadonlyMap<string, Manifest>,
  targets: ReadonlyMap<string, ResolvedTarget>,
  overrides: Overrides,
  diagnostics: string[],
  icons: ReadonlySet<string> | undefined,
): ResolvedWidget {
  const manifest = catalog.get(widget.type)
  if (manifest === undefined) {
    diagnostics.push(
      `widget "${widget.id}" uses type "${widget.type}", which is not in the catalog; ` +
        'it will render as a placeholder rather than disappear',
    )
  }

  const config = {
    ...manifestDefaults(manifest),
    ...widget.config,
    ...(overrides.widgets[widget.id]?.config ?? {}),
  }

  const template = manifest?.presentation.template ?? 'link-tile'

  return {
    id: widget.id,
    page: widget.page,
    type: widget.type,
    title: widget.title ?? manifest?.displayName ?? widget.type,
    template,
    icon: manifest?.icon ?? 'question-mark',
    targetId: widget.targetId,
    // A composite's bindings are only meaningful for the roles its manifest declares; a role that
    // was removed by a catalog update leaves its targets in config (nothing is deleted behind the
    // user's back) but stops being fetched.
    bindings:
      manifest !== undefined && isComposite(manifest)
        ? Object.fromEntries(
            Object.keys(manifest.roles).map((role) => [role, widget.bindings[role] ?? []]),
          )
        : {},
    config,
    operations:
      manifest !== undefined && isComposite(manifest)
        ? []
        : widget.operations.length > 0
          ? widget.operations
          : Object.keys(manifest?.operations ?? {}),
    // A user's explicit interval wins, but never below what the manifest says the service tolerates.
    pollIntervalMs: Math.max(
      manifest?.poll.minIntervalMs ?? 15_000,
      widget.poll.intervalMs ?? manifest?.poll.defaultIntervalMs ?? 60_000,
    ),
    unsupported: manifest === undefined,
    href: linkHref(
      template,
      config,
      widget.targetId === null ? undefined : targets.get(widget.targetId),
    ),
    iconUrl: iconUrl(manifest?.icon, icons),
  }
}

function resolveTarget(target: Target, overrides: Overrides): ResolvedTarget {
  const base = { ...target.base, ...(overrides.targets[target.id]?.base ?? {}) }
  return {
    id: target.id,
    label: target.label,
    origin: `${base.scheme}://${base.host}:${base.port}`,
    secretRefs: Object.fromEntries(
      Object.entries(target.secrets).map(([field, ref]) => [field, ref.$secret]),
    ),
    minIntervalMs: target.minIntervalMs,
  }
}

/**
 * Produce a layout for a breakpoint nobody has authored.
 *
 * `correctBounds` mutates its argument — verified against react-grid-layout 2.2.4 — so the clone
 * is not defensive style, it is what keeps this function pure. Without it, resolving would rewrite
 * the parsed config object and the next save would persist machine-derived geometry into a
 * git-tracked file.
 */
export function deriveLayout(
  authored: readonly LayoutItem[],
  fromCols: number,
  toCols: number,
): LayoutItem[] {
  const ratio = toCols / fromCols
  const scaled = authored.map((item) => {
    const w = Math.max(1, Math.min(toCols, Math.round(item.w * ratio)))
    const x = Math.max(0, Math.min(toCols - w, Math.round(item.x * ratio)))
    return { ...item, x, y: item.y, w }
  })
  const bounded = correctBounds(cloneLayout(scaled), { cols: toCols })
  return getCompactor('vertical').compact(bounded, toCols) as LayoutItem[]
}

function resolveLink(link: BookmarkLink, icons: ReadonlySet<string> | undefined): ResolvedLink {
  const ref = link.icon === null ? null : parseIconRef(link.icon)
  return {
    id: link.id,
    label: link.label,
    href: composeHref(link.base, link.path),
    icon: link.icon,
    iconUrl: iconUrl(link.icon, icons),
    iconMode: ref === null ? 'image' : iconMode(ref),
    iconColor: ref?.color === null || ref === null ? null : `#${ref.color}`,
  }
}

function resolveNavItem(item: NavItem, icons: ReadonlySet<string> | undefined): ResolvedNavItem {
  switch (item.kind) {
    case 'title':
      return { id: item.id, kind: 'title' }
    case 'text':
      return { id: item.id, kind: 'text', text: item.text }
    case 'links':
      return {
        id: item.id,
        kind: 'links',
        links: item.links.map((link) => resolveLink(link, icons)),
      }
    case 'clock':
      return { id: item.id, kind: 'clock', showDate: item.showDate, hour12: item.hour12 }
    case 'search':
      return { id: item.id, kind: 'search', engine: item.engine, placeholder: item.placeholder }
    case 'spacer':
      return { id: item.id, kind: 'spacer' }
  }
}

/** Groups per row when a bookmarks section says nothing: a third of the grid's columns, at least one. */
function defaultBookmarkColumns(gridCols: number): number {
  return Math.max(1, Math.min(12, Math.round(gridCols / 3)))
}

/**
 * One section, dense.
 *
 * A grid section gets the page grid with its own column counts and row cap substituted in, and
 * its slice of the page's layout file: the file is flat per breakpoint, and a section's layout is
 * the entries whose widget lives in it. Coordinates are therefore per section — every board
 * starts at row zero — which is also what the editor renders, one grid per section.
 */
function resolveSection(
  section: Section,
  page: Page,
  pageWidgets: readonly Widget[],
  stored: Readonly<Record<string, readonly LayoutItem[]>>,
  meta: Readonly<Record<string, { readonly origin: 'authored' | 'derived' }>>,
  icons: ReadonlySet<string> | undefined,
): ResolvedSection {
  switch (section.kind) {
    case 'navbar':
      return {
        id: section.id,
        kind: 'navbar',
        title: section.title,
        items: section.items.map((item) => resolveNavItem(item, icons)),
      }

    case 'bookmarks':
      return {
        id: section.id,
        kind: 'bookmarks',
        title: section.title,
        columns: Object.fromEntries(
          page.grid.breakpoints.map((breakpoint) => [
            breakpoint.id,
            section.columns[breakpoint.id] ?? defaultBookmarkColumns(breakpoint.cols),
          ]),
        ),
        display: section.display,
        groups: section.groups.map((group) => ({
          id: group.id,
          title: group.title,
          links: group.links.map((link) => resolveLink(link, icons)),
        })),
      }

    case 'grid': {
      const grid: Page['grid'] = {
        ...page.grid,
        breakpoints: page.grid.breakpoints.map((breakpoint) => ({
          ...breakpoint,
          cols: section.cols[breakpoint.id] ?? breakpoint.cols,
        })),
        maxRows: section.maxRows ?? page.grid.maxRows,
      }
      const widgetIds = pageWidgets
        .filter((widget) => sectionOf(widget, page) === section.id)
        .map((widget) => widget.id)
      const authoritative = grid.breakpoints.find((b) => b.id === grid.authoritative)
      const layouts: Record<string, readonly LayoutItem[]> = {}

      for (const breakpoint of grid.breakpoints) {
        const items = stored[breakpoint.id]
        if (items !== undefined && meta[breakpoint.id]?.origin !== 'derived') {
          layouts[breakpoint.id] = items.filter((item) => widgetIds.includes(item.i))
          continue
        }
        const source = authoritative === undefined ? undefined : stored[authoritative.id]
        if (source === undefined || authoritative === undefined) {
          layouts[breakpoint.id] = []
          continue
        }
        layouts[breakpoint.id] = deriveLayout(
          source.filter((item) => widgetIds.includes(item.i)),
          authoritative.cols,
          breakpoint.cols,
        )
      }

      return { id: section.id, kind: 'grid', title: section.title, grid, layouts, widgetIds }
    }
  }
}

export function resolve(input: ResolveInput): Resolved {
  const { tree, catalog, generatedAt } = input
  const overrides = input.overrides ?? EMPTY_OVERRIDES
  const diagnostics: string[] = []

  // Targets first: a widget's href is derived from the target it binds.
  const targets = [...tree.targets.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en-US'))
    .map((target) => resolveTarget(target, overrides))
  const targetsById = new Map(targets.map((target) => [target.id, target]))

  const widgets = [...tree.widgets.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en-US'))
    .map((widget) =>
      resolveWidget(widget, catalog, targetsById, overrides, diagnostics, input.icons),
    )

  const pages: ResolvedPage[] = []
  for (const pageId of tree.dashboard.pages) {
    const page = tree.pages.get(pageId)
    if (page === undefined) continue

    const layoutFile = tree.layouts.get(pageId)
    const pageWidgets = [...tree.widgets.values()]
      .filter((w) => w.page === pageId)
      .sort((a, b) => a.id.localeCompare(b.id, 'en-US'))
    const sections = effectiveSections(page).map((section) =>
      resolveSection(
        section,
        page,
        pageWidgets,
        layoutFile?.layouts ?? {},
        layoutFile?.meta ?? {},
        input.icons,
      ),
    )

    // A widget with no placement anywhere is invisible with no error, which reads as data loss.
    for (const widget of pageWidgets) {
      const placed = sections.some(
        (section) =>
          section.kind === 'grid' &&
          Object.values(section.layouts).some((items) =>
            items.some((item) => item.i === widget.id),
          ),
      )
      if (!placed) diagnostics.push(`widget "${widget.id}" has no layout entry on any breakpoint`)
    }

    pages.push({
      id: page.id,
      title: page.title,
      grid: page.grid,
      sections,
      widgetIds: pageWidgets.map((w) => w.id),
    })
  }

  for (const widget of widgets) {
    if (widget.targetId !== null && !targets.some((t) => t.id === widget.targetId)) {
      diagnostics.push(`widget "${widget.id}" points at missing target "${widget.targetId}"`)
    }
    for (const [role, bound] of Object.entries(widget.bindings)) {
      for (const targetId of bound) {
        if (!targets.some((t) => t.id === targetId)) {
          diagnostics.push(
            `widget "${widget.id}" binds missing target "${targetId}" to role "${role}"`,
          )
        }
      }
    }
  }

  return {
    schemaVersion: tree.dashboard.schemaVersion,
    title: tree.dashboard.title,
    defaultPage: tree.dashboard.defaultPage,
    generatedAt,
    pages,
    widgets,
    targets,
    theme: tree.theme,
    features: tree.dashboard.features,
    diagnostics,
  }
}
