/**
 * @neohomepage/catalog-schema
 *
 * The versioned contract between the app and the widget catalog. Published to npm so the
 * catalog's own CI can validate a community PR without vendoring anything, and so extracting
 * `catalog/` into its own repository later is a dependency bump rather than a breaking change.
 *
 * Nothing here may import from the app. Nothing here may touch the filesystem or the network.
 */

/** Manifest schema revisions this build understands. Refuse anything outside the list. */
export const SUPPORTED_MANIFEST_VERSIONS = [1] as const

export type ManifestVersion = (typeof SUPPORTED_MANIFEST_VERSIONS)[number]

export const CATALOG_SCHEMA_VERSION = '0.0.1'
