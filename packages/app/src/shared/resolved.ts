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
  readonly diagnostics: readonly string[]
}
