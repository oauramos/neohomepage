import { cloneLayout, correctBounds, getCompactor } from 'react-grid-layout/core'
import type { Manifest } from '@neohomepage/catalog-schema'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import type { Page, Target, Theme, Widget } from '../config/schema.ts'
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

export type ResolvedWidget = {
  readonly id: string
  readonly page: string
  readonly type: string
  readonly title: string
  readonly template: string
  readonly icon: string
  readonly targetId: string | null
  readonly config: Readonly<Record<string, unknown>>
  readonly operations: readonly string[]
  readonly pollIntervalMs: number
  /** Absent from the catalog: renders as a labelled placeholder instead of vanishing. */
  readonly unsupported: boolean
}

export type ResolvedPage = {
  readonly id: string
  readonly title: string
  readonly grid: Page['grid']
  readonly layouts: Readonly<Record<string, readonly LayoutItem[]>>
  readonly widgetIds: readonly string[]
}

export type ResolvedTarget = {
  readonly id: string
  readonly label: string
  /** Origin only — never a full URL, and never anything a manifest supplied. */
  readonly origin: string
  readonly minIntervalMs: number
}

export type Resolved = {
  readonly schemaVersion: number
  readonly title: string
  readonly defaultPage: string
  readonly generatedAt: string
  readonly pages: readonly ResolvedPage[]
  readonly widgets: readonly ResolvedWidget[]
  readonly targets: readonly ResolvedTarget[]
  readonly theme: Theme
  readonly diagnostics: readonly string[]
}

export type ResolveInput = {
  readonly tree: ConfigTree
  readonly catalog: ReadonlyMap<string, Manifest>
  readonly overrides?: Overrides
  readonly generatedAt: string
}

function manifestDefaults(manifest: Manifest | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const field of manifest?.config ?? []) {
    if (field.default !== undefined) defaults[field.name] = field.default
  }
  return defaults
}

function resolveWidget(
  widget: Widget,
  catalog: ReadonlyMap<string, Manifest>,
  overrides: Overrides,
  diagnostics: string[],
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

  return {
    id: widget.id,
    page: widget.page,
    type: widget.type,
    title: widget.title ?? manifest?.displayName ?? widget.type,
    template: manifest?.presentation.template ?? 'link-tile',
    icon: manifest?.icon ?? 'question-mark',
    targetId: widget.targetId,
    config,
    operations:
      widget.operations.length > 0 ? widget.operations : Object.keys(manifest?.operations ?? {}),
    // A user's explicit interval wins, but never below what the manifest says the service tolerates.
    pollIntervalMs: Math.max(
      manifest?.poll.minIntervalMs ?? 15_000,
      widget.poll.intervalMs ?? manifest?.poll.defaultIntervalMs ?? 60_000,
    ),
    unsupported: manifest === undefined,
  }
}

function resolveTarget(target: Target, overrides: Overrides): ResolvedTarget {
  const base = { ...target.base, ...(overrides.targets[target.id]?.base ?? {}) }
  return {
    id: target.id,
    label: target.label,
    origin: `${base.scheme}://${base.host}:${base.port}`,
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

export function resolve(input: ResolveInput): Resolved {
  const { tree, catalog, generatedAt } = input
  const overrides = input.overrides ?? EMPTY_OVERRIDES
  const diagnostics: string[] = []

  const widgets = [...tree.widgets.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en-US'))
    .map((widget) => resolveWidget(widget, catalog, overrides, diagnostics))

  const targets = [...tree.targets.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en-US'))
    .map((target) => resolveTarget(target, overrides))

  const pages: ResolvedPage[] = []
  for (const pageId of tree.dashboard.pages) {
    const page = tree.pages.get(pageId)
    if (page === undefined) continue

    const layoutFile = tree.layouts.get(pageId)
    const pageWidgets = widgets.filter((w) => w.page === pageId).map((w) => w.id)
    const authoritative = page.grid.breakpoints.find((b) => b.id === page.grid.authoritative)
    const layouts: Record<string, readonly LayoutItem[]> = {}

    for (const breakpoint of page.grid.breakpoints) {
      const stored = layoutFile?.layouts[breakpoint.id]
      const origin = layoutFile?.meta[breakpoint.id]?.origin
      if (stored !== undefined && origin !== 'derived') {
        layouts[breakpoint.id] = stored.filter((item) => pageWidgets.includes(item.i))
        continue
      }
      const source = authoritative === undefined ? undefined : layoutFile?.layouts[authoritative.id]
      if (source === undefined || authoritative === undefined) {
        layouts[breakpoint.id] = []
        continue
      }
      layouts[breakpoint.id] = deriveLayout(
        source.filter((item) => pageWidgets.includes(item.i)),
        authoritative.cols,
        breakpoint.cols,
      )
    }

    // A widget with no placement anywhere is invisible with no error, which reads as data loss.
    for (const id of pageWidgets) {
      const placed = Object.values(layouts).some((items) => items.some((item) => item.i === id))
      if (!placed) diagnostics.push(`widget "${id}" has no layout entry on any breakpoint`)
    }

    pages.push({
      id: page.id,
      title: page.title,
      grid: page.grid,
      layouts,
      widgetIds: pageWidgets,
    })
  }

  for (const widget of widgets) {
    if (widget.targetId !== null && !targets.some((t) => t.id === widget.targetId)) {
      diagnostics.push(`widget "${widget.id}" points at missing target "${widget.targetId}"`)
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
    diagnostics,
  }
}
