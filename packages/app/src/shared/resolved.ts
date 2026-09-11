import type { BookmarkDisplay, Page, SearchEngine, Theme } from '../server/config/schema.ts'
import type { LayoutItem } from './grid-geometry.ts'

/**
 * The dense, fully-evaluated dashboard.
 *
 * These types live in shared, not next to resolve(), because the browser renders the same
 * structure the publish step does and neither side may import the other's module tree.
 */

export type ResolvedWidget = {
  readonly id: string
  readonly page: string
  readonly type: string
  readonly title: string
  readonly template: string
  readonly icon: string
  readonly targetId: string | null
  /** Composite widgets: role name -> bound target ids. Empty for the single-target shape. */
  readonly bindings: Readonly<Record<string, readonly string[]>>
  readonly config: Readonly<Record<string, unknown>>
  readonly operations: readonly string[]
  readonly pollIntervalMs: number
  /** Absent from the catalog: renders as a labelled placeholder instead of vanishing. */
  readonly unsupported: boolean
  /**
   * Where a bookmark points: the bound target's origin plus the configured path, for the
   * link-tile template only; null for everything else.
   *
   * Resolved here rather than read out of the projection, because a projection only exists once
   * a fetch has succeeded — and a bookmark is a link first and a liveness check second. Most real
   * services answer `GET /` with a redirect to a login page, a 401, or a self-signed certificate,
   * and none of those is a reason for the link to vanish from the tile.
   */
  readonly href: string | null
  /** The cached icon for this widget's type, as a page-relative URL, or null until it is cached. */
  readonly iconUrl: string | null
}

/** A bookmark or navbar link with its destination composed: origin plus path, never a raw URL from config. */
export type ResolvedLink = {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly icon: string | null
  /** Page-relative URL of the cached icon; null until fetched, or when the name is unknown. */
  readonly iconUrl: string | null
  /** `image` draws the file as-is; `mask` paints its shape in `iconColor`, or the text colour. */
  readonly iconMode: 'image' | 'mask'
  readonly iconColor: string | null
}

export type ResolvedNavItem =
  | { readonly id: string; readonly kind: 'title' }
  | { readonly id: string; readonly kind: 'text'; readonly text: string }
  | { readonly id: string; readonly kind: 'links'; readonly links: readonly ResolvedLink[] }
  | {
      readonly id: string
      readonly kind: 'clock'
      readonly showDate: boolean
      readonly hour12: boolean
    }
  | {
      readonly id: string
      readonly kind: 'search'
      readonly engine: SearchEngine
      readonly placeholder: string
    }
  | { readonly id: string; readonly kind: 'spacer' }

export type ResolvedNavbarSection = {
  readonly id: string
  readonly kind: 'navbar'
  readonly title: string | null
  readonly items: readonly ResolvedNavItem[]
}

/**
 * A grid section carries a complete grid config of its own — the page's, with this section's
 * column counts and row cap applied — so the renderer, the CSS emitter and the editor never have
 * to know which numbers were overridden and which were inherited.
 */
export type ResolvedGridSection = {
  readonly id: string
  readonly kind: 'grid'
  readonly title: string | null
  readonly grid: Page['grid']
  readonly layouts: Readonly<Record<string, readonly LayoutItem[]>>
  readonly widgetIds: readonly string[]
}

export type ResolvedBookmarkGroup = {
  readonly id: string
  readonly title: string
  readonly links: readonly ResolvedLink[]
}

export type ResolvedBookmarksSection = {
  readonly id: string
  readonly kind: 'bookmarks'
  readonly title: string | null
  /** Groups per row, keyed by breakpoint id — dense, every breakpoint present. */
  readonly columns: Readonly<Record<string, number>>
  readonly display: BookmarkDisplay
  readonly groups: readonly ResolvedBookmarkGroup[]
}

export type ResolvedSection = ResolvedNavbarSection | ResolvedGridSection | ResolvedBookmarksSection

export type ResolvedPage = {
  readonly id: string
  readonly title: string
  readonly grid: Page['grid']
  /** In display order. Always at least one grid section, even when the page declares none. */
  readonly sections: readonly ResolvedSection[]
  readonly widgetIds: readonly string[]
}

export type ResolvedTarget = {
  readonly id: string
  readonly label: string
  /** Origin only — never a full URL, and never anything a manifest supplied. */
  readonly origin: string
  /**
   * Field name to secret NAME. Never a value, and never a length.
   *
   * Carried here so a client can be told "this target needs a credential called X and it is not
   * set" without another round trip, and so the editor can show a saved secret as saved. A name
   * is not a secret; a length would be, which is why one is here and the other never is.
   */
  readonly secretRefs: Readonly<Record<string, string>>
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
  /** Optional behaviour the browser acts on; see `dashboardSchema.features`. */
  readonly features: { readonly autoHideControls: boolean; readonly autoHideDelayMs: number }
  readonly diagnostics: readonly string[]
}
