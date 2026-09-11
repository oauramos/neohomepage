import type { Page, Theme } from '../server/config/schema.ts'
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
