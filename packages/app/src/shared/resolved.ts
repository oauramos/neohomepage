import type { BookmarkDisplay, Page, Theme } from '../server/config/schema.ts'
import type { SearchEngine } from './links.ts'
import type { LayoutItem } from './grid-geometry.ts'

/**
 * The fully-evaluated dashboard. Lives in shared because both the browser and the publish step
 * render it.
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
   * Bound target origin plus configured path, for the link-tile template only; null otherwise.
   * Resolved from config rather than the projection so the link survives a failed fetch.
   */
  readonly href: string | null
  /** The cached icon for this widget's type, as a page-relative URL, or null until it is cached. */
  readonly iconUrl: string | null
  /** This tile's own choice for how readings are drawn; `inherit` follows the theme tokens. */
  readonly look: {
    readonly stats: 'inherit' | 'plain' | 'boxed'
    readonly align: 'inherit' | 'start' | 'center'
  }
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
  | { readonly id: string; readonly kind: 'title'; readonly boxed: boolean }
  | { readonly id: string; readonly kind: 'text'; readonly text: string; readonly boxed: boolean }
  | {
      readonly id: string
      readonly kind: 'links'
      readonly links: readonly ResolvedLink[]
      readonly boxed: boolean
    }
  | {
      readonly id: string
      readonly kind: 'clock'
      readonly showDate: boolean
      readonly hour12: boolean
      readonly boxed: boolean
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
 * Carries a complete grid config (the page's with this section's column counts and row cap
 * applied) so consumers never need to know which values were inherited.
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
   * Field name to secret NAME, never a value or a length: lets a client report a missing
   * credential and the editor show a saved one.
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
