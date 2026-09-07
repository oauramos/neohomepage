import { z } from 'zod'

/**
 * The projection DSL.
 *
 * A widget manifest is downloaded from a public catalog and then evaluated against a credentialed
 * service on the user's LAN. That single fact dictates the whole design: the language is a JSON
 * node tree, not a string to parse; there is no `eval`, no `new Function`, no regular expressions
 * (so no ReDoS), no recursion and no user-defined functions. It is total — a missing path yields
 * null rather than an exception — and it terminates by construction, with static caps enforced at
 * load time and a fuel budget enforced at run time.
 *
 * The operator set is closed and every member earns its place by a real widget. It is deliberately
 * cheaper to add an operator here, with a test, than to add an escape hatch.
 */

export const COMPARISONS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const
export type Comparison = (typeof COMPARISONS)[number]

export const ARITHMETIC = ['add', 'sub', 'mul', 'div'] as const
export type Arithmetic = (typeof ARITHMETIC)[number]

/** Terminal presentation hints. Closed so a template knows every shape it can receive. */
export const FORMATS = [
  'bytes',
  'bitrate',
  'duration',
  'relativeTime',
  'date',
  'percent',
  'number',
  'temperature',
] as const
export type Format = (typeof FORMATS)[number]

export const SORT_TYPES = ['numeric', 'string', 'date'] as const
export type SortType = (typeof SORT_TYPES)[number]

export type SortKey = {
  readonly path: string
  readonly dir?: 'asc' | 'desc'
  readonly type?: SortType
}

export type Node =
  // --- data ---
  | { readonly op: 'get'; readonly path: string }
  | { readonly op: 'const'; readonly value: unknown }
  | { readonly op: 'now' }
  // --- structure ---
  | { readonly op: 'pick'; readonly fields: Readonly<Record<string, Node>> }
  | { readonly op: 'map'; readonly over: Node; readonly as: string; readonly body: Node }
  | { readonly op: 'filter'; readonly over: Node; readonly as: string; readonly where: Node }
  | { readonly op: 'sort'; readonly over: Node; readonly by: readonly SortKey[] }
  | { readonly op: 'limit'; readonly over: Node; readonly n: number }
  | { readonly op: 'distinctBy'; readonly over: Node; readonly by: string }
  | { readonly op: 'concat'; readonly of: readonly Node[] }
  | {
      readonly op: 'lookup'
      readonly over: Node
      readonly as: string
      readonly in: Node
      readonly onLeft: string
      readonly onRight: string
      readonly bind: string
      readonly body: Node
    }
  // --- aggregation ---
  | { readonly op: 'count'; readonly of: Node }
  | { readonly op: 'sum'; readonly of: Node; readonly path?: string }
  | { readonly op: 'avg'; readonly of: Node; readonly path?: string }
  | { readonly op: 'min'; readonly of: Node; readonly path?: string }
  | { readonly op: 'max'; readonly of: Node; readonly path?: string }
  | { readonly op: 'first'; readonly of: Node }
  // --- logic ---
  | { readonly op: 'if'; readonly cond: Node; readonly then: Node; readonly else: Node }
  | { readonly op: 'coalesce'; readonly of: readonly Node[] }
  | { readonly op: 'and'; readonly of: readonly Node[] }
  | { readonly op: 'or'; readonly of: readonly Node[] }
  | { readonly op: 'not'; readonly of: Node }
  | { readonly op: 'compare'; readonly cmp: Comparison; readonly left: Node; readonly right: Node }
  | { readonly op: 'in'; readonly needle: Node; readonly haystack: Node }
  // --- arithmetic ---
  | { readonly op: 'arith'; readonly fn: Arithmetic; readonly of: readonly Node[] }
  | { readonly op: 'clamp'; readonly of: Node; readonly min: number; readonly max: number }
  // --- mapping and links ---
  | {
      readonly op: 'mapValue'
      readonly of: Node
      readonly cases: Readonly<Record<string, unknown>>
      readonly fallback?: unknown
    }
  | { readonly op: 'targetUrl'; readonly path: Node }
  // --- terminal ---
  | { readonly op: 'format'; readonly of: Node; readonly as: Format }

export const OP_NAMES = [
  'get',
  'const',
  'now',
  'pick',
  'map',
  'filter',
  'sort',
  'limit',
  'distinctBy',
  'concat',
  'lookup',
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'first',
  'if',
  'coalesce',
  'and',
  'or',
  'not',
  'compare',
  'in',
  'arith',
  'clamp',
  'mapValue',
  'targetUrl',
  'format',
] as const satisfies readonly Node['op'][]

export type OpName = (typeof OP_NAMES)[number]

/**
 * A path is a dotted walk with numeric segments indexing arrays: `series.title`, `records.0.size`,
 * `$` for the whole scope root. No wildcards, no filters, no expressions — anything richer belongs
 * in an operator where it can be reviewed.
 */
const pathSchema = z
  .string()
  .max(200)
  // The head is either the source root `$` or a plain identifier naming a binding; `$` is not
  // allowed inside an identifier, so a typo like `$$$` is refused at review time rather than
  // silently resolving to null forever and leaving a widget mysteriously blank.
  .regex(/^\$(\.[A-Za-z0-9_-]+)*$|^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/, 'invalid path')

const bindingName = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/, 'invalid binding name')

const sortKeySchema = z.object({
  path: pathSchema,
  dir: z.enum(['asc', 'desc']).optional(),
  type: z.enum(SORT_TYPES).optional(),
})

/** JSON literals allowed inside `const`, `mapValue` cases and similar. */
const jsonLiteral: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonLiteral),
    z.record(z.string(), jsonLiteral),
  ]),
)

export const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('get'), path: pathSchema }),
    z.object({ op: z.literal('const'), value: jsonLiteral }),
    z.object({ op: z.literal('now') }),

    z.object({ op: z.literal('pick'), fields: z.record(z.string().max(64), nodeSchema) }),
    z.object({ op: z.literal('map'), over: nodeSchema, as: bindingName, body: nodeSchema }),
    z.object({ op: z.literal('filter'), over: nodeSchema, as: bindingName, where: nodeSchema }),
    z.object({ op: z.literal('sort'), over: nodeSchema, by: z.array(sortKeySchema).min(1).max(4) }),
    z.object({ op: z.literal('limit'), over: nodeSchema, n: z.int().min(0).max(5000) }),
    z.object({ op: z.literal('distinctBy'), over: nodeSchema, by: pathSchema }),
    z.object({ op: z.literal('concat'), of: z.array(nodeSchema).min(1).max(16) }),
    z.object({
      op: z.literal('lookup'),
      over: nodeSchema,
      as: bindingName,
      in: nodeSchema,
      onLeft: pathSchema,
      onRight: pathSchema,
      bind: bindingName,
      body: nodeSchema,
    }),

    z.object({ op: z.literal('count'), of: nodeSchema }),
    z.object({ op: z.literal('sum'), of: nodeSchema, path: pathSchema.optional() }),
    z.object({ op: z.literal('avg'), of: nodeSchema, path: pathSchema.optional() }),
    z.object({ op: z.literal('min'), of: nodeSchema, path: pathSchema.optional() }),
    z.object({ op: z.literal('max'), of: nodeSchema, path: pathSchema.optional() }),
    z.object({ op: z.literal('first'), of: nodeSchema }),

    z.object({ op: z.literal('if'), cond: nodeSchema, then: nodeSchema, else: nodeSchema }),
    z.object({ op: z.literal('coalesce'), of: z.array(nodeSchema).min(1).max(16) }),
    z.object({ op: z.literal('and'), of: z.array(nodeSchema).min(1).max(16) }),
    z.object({ op: z.literal('or'), of: z.array(nodeSchema).min(1).max(16) }),
    z.object({ op: z.literal('not'), of: nodeSchema }),
    z.object({
      op: z.literal('compare'),
      cmp: z.enum(COMPARISONS),
      left: nodeSchema,
      right: nodeSchema,
    }),
    z.object({ op: z.literal('in'), needle: nodeSchema, haystack: nodeSchema }),

    z.object({
      op: z.literal('arith'),
      fn: z.enum(ARITHMETIC),
      of: z.array(nodeSchema).min(1).max(16),
    }),
    z.object({ op: z.literal('clamp'), of: nodeSchema, min: z.number(), max: z.number() }),

    z.object({
      op: z.literal('mapValue'),
      of: nodeSchema,
      cases: z.record(z.string().max(64), jsonLiteral),
      fallback: jsonLiteral.optional(),
    }),
    z.object({ op: z.literal('targetUrl'), path: nodeSchema }),

    z.object({ op: z.literal('format'), of: nodeSchema, as: z.enum(FORMATS) }),
  ]),
) as z.ZodType<Node>
