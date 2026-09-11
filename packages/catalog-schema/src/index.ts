/**
 * The versioned contract between the app and the widget catalog, published to npm so the catalog's
 * CI can validate manifests without vendoring the app. Must not import from the app, touch the
 * filesystem or reach the network.
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
  Category,
  Compose,
  CompositeManifest,
  Decoder,
  Field,
  FieldKind,
  Manifest,
  ManifestProblem,
  Operation,
  Requires,
  Role,
  SingleManifest,
  SourceKind,
  Template,
} from './manifest.ts'
export {
  auditManifest,
  authSchema,
  AUTH_KINDS,
  CATEGORIES,
  composeSchema,
  compositeManifestSchema,
  DECODERS,
  deriveRequires,
  fieldSchema,
  FIELD_KINDS,
  isComposite,
  manifestSchema,
  operationSchema,
  parseManifest,
  requiresSchema,
  roleSchema,
  singleManifestSchema,
  sourceKinds,
  sourceKindSchema,
  TEMPLATES,
} from './manifest.ts'

export type { DisplayValue, Projection, ProjectionEnvelope } from './projection.ts'
export { displayValueSchema, projectionSchema } from './projection.ts'

/** Manifest schema revisions this build understands. Refuse anything outside the list. */
export const SUPPORTED_MANIFEST_VERSIONS = [1] as const
export type ManifestVersion = (typeof SUPPORTED_MANIFEST_VERSIONS)[number]
