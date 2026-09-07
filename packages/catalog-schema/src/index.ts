/**
 * @neohomepage/catalog-schema
 *
 * The versioned contract between the app and the widget catalog. Published to npm so the
 * catalog's own CI can validate a community pull request without vendoring anything, and so
 * extracting `catalog/` into its own repository later is a dependency bump rather than a break.
 *
 * Nothing here may import from the app, touch the filesystem, or reach the network.
 */

export type { Json, JsonObject } from './json.ts'
export { isJsonArray, isJsonObject } from './json.ts'

export type { Arithmetic, Comparison, Format, Node, OpName, SortKey, SortType } from './dsl/node.ts'
export { ARITHMETIC, COMPARISONS, FORMATS, OP_NAMES, SORT_TYPES, nodeSchema } from './dsl/node.ts'

export type { Analysis, Limits } from './dsl/walk.ts'
export {
  analyse,
  children,
  DEFAULT_LIMITS,
  ProjectionTooComplexError,
  usedOpcodes,
} from './dsl/walk.ts'

export type { EvalContext, EvalLimits, ProjectionResult } from './dsl/evaluate.ts'
export { DEFAULT_EVAL_LIMITS, ProjectionLimitError, runProjection } from './dsl/evaluate.ts'

export type {
  Auth,
  AuthKind,
  Decoder,
  Field,
  FieldKind,
  Manifest,
  ManifestProblem,
  Operation,
  Requires,
  Template,
} from './manifest.ts'
export {
  auditManifest,
  authSchema,
  AUTH_KINDS,
  DECODERS,
  deriveRequires,
  fieldSchema,
  FIELD_KINDS,
  manifestSchema,
  operationSchema,
  requiresSchema,
  TEMPLATES,
} from './manifest.ts'

export type { DisplayValue, Projection, ProjectionEnvelope } from './projection.ts'
export { displayValueSchema, projectionSchema } from './projection.ts'

/** Manifest schema revisions this build understands. Refuse anything outside the list. */
export const SUPPORTED_MANIFEST_VERSIONS = [1] as const
export type ManifestVersion = (typeof SUPPORTED_MANIFEST_VERSIONS)[number]

export const CATALOG_SCHEMA_VERSION = '0.0.1'
