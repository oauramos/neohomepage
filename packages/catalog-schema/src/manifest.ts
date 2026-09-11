import { z } from 'zod'
import { nodeSchema } from './dsl/node.ts'
import { usedOpcodes } from './dsl/walk.ts'

/**
 * Widget manifest schema: the one hand-written artefact per integration, from which the edit form,
 * MCP tool schema, proxy endpoint allowlist and secret-stripping rule are all derived.
 */

export const TEMPLATES = ['stat-grid', 'list', 'gauge-set', 'status-badge', 'link-tile'] as const
export type Template = (typeof TEMPLATES)[number]

export const DECODERS = ['json', 'ics', 'text'] as const
export type Decoder = (typeof DECODERS)[number]

export const AUTH_KINDS = ['none', 'header', 'basic', 'query', 'session-exchange'] as const
export type AuthKind = (typeof AUTH_KINDS)[number]

export const FIELD_KINDS = [
  'string',
  'integer',
  'number',
  'boolean',
  'enum',
  'url',
  'duration',
  'color',
  'icon',
  'secret',
] as const
export type FieldKind = (typeof FIELD_KINDS)[number]

const identifier = z.string().regex(/^[a-z][a-z0-9-]{1,48}$/, 'must be a lowercase slug')

/**
 * Closed set: a free-form slug yields near-duplicate browse headings, and a category is a public
 * contract that cannot be renamed later. Spellings are en-US.
 */
export const CATEGORIES = [
  'virtualization',
  'nas',
  'media',
  'media-automation',
  'downloads',
  'network',
  'monitoring',
  'information',
  'misc',
] as const
export type Category = (typeof CATEGORIES)[number]
const fieldName = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/, 'must be a camelCase field name')

/** UI hints ride along in a reserved key so one definition drives validation, form and docs. */
const uiHints = z
  .object({
    group: z.string().max(32).optional(),
    order: z.int().optional(),
    placeholder: z.string().max(80).optional(),
  })
  .optional()

export const fieldSchema = z.object({
  name: fieldName,
  kind: z.enum(FIELD_KINDS),
  label: z.string().min(1).max(64),
  help: z.string().max(240).optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  /** enum only. */
  options: z
    .array(z.object({ value: z.string().max(64), label: z.string().max(64) }))
    .max(32)
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  ui: uiHints,
})
export type Field = z.infer<typeof fieldSchema>

// A secret may be referenced only from an auth template, never from a path or query: a credential
// in a URL ends up in logs and gives a hostile manifest an exfiltration channel.
const secretRef = /\{\{secret:([a-zA-Z][A-Za-z0-9]*)\}\}/g

export const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('header'),
    header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,48}$/),
    value: z.string().max(200),
  }),
  z.object({
    kind: z.literal('basic'),
    username: z.string().max(200),
    password: z.string().max(200),
  }),
  z.object({
    kind: z.literal('query'),
    param: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,32}$/),
    value: z.string().max(200),
  }),
  z.object({
    kind: z.literal('session-exchange'),
    // For upstreams that hand out a session token or cookie from a login call (Pi-hole v6,
    // qBittorrent), which a stateless auth model cannot express.
    loginPath: z.string().max(200),
    body: z.record(z.string().max(32), z.string().max(200)),
    /** Dotted path to the token in the JSON login response. Required by `sendAs: header`. */
    tokenPath: z.string().max(120).optional(),
    sendAs: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('header'),
        header: z.string().max(48),
        /** `{{session}}` is replaced by the token; nothing else is interpolated here. */
        value: z.string().max(200),
      }),
      z.object({ kind: z.literal('cookie') }),
    ]),
  }),
])
export type Auth = z.infer<typeof authSchema>

/** Path templates interpolate declared, typed config fields — never a host and never a secret. */
const pathTemplate = z
  .string()
  .min(1)
  .max(200)
  // The colon admits the `{{config:name}}` hole syntax, the same form `auth` uses.
  .regex(
    /^\/[A-Za-z0-9._~\-/{}:]*$/,
    'must be an absolute path containing only {{config:name}} holes',
  )

export const operationSchema = z.object({
  method: z.enum(['GET', 'POST']),
  path: pathTemplate,
  decode: z.enum(DECODERS).default('json'),
  query: z.record(z.string().max(32), z.string().max(200)).optional(),
  /** Static request headers only. Anything credential-shaped belongs in `auth`. */
  headers: z.record(z.string().max(48), z.string().max(200)).optional(),
})
export type Operation = z.infer<typeof operationSchema>

export const requiresSchema = z.object({
  templates: z.array(z.enum(TEMPLATES)),
  opcodes: z.array(z.string().max(24)),
  authKinds: z.array(z.enum(AUTH_KINDS)),
  fetchKinds: z.array(z.enum(DECODERS)),
})
export type Requires = z.infer<typeof requiresSchema>

/**
 * One upstream shape a role accepts, self-contained (own fields, auth, operation) so a composite
 * can bind sources that authenticate differently without depending on another manifest.
 * `emits` fans one response out into several streams.
 */
export const sourceKindSchema = z
  .object({
    label: z.string().min(1).max(48),
    fields: z.array(fieldSchema).max(16).default([]),
    auth: authSchema,
    operation: operationSchema,
    emits: z
      .array(
        z.object({
          id: fieldName,
          label: z.string().min(1).max(48),
          /** Must evaluate to an array of render-contract items; the catalog runner proves it. */
          projection: nodeSchema,
        }),
      )
      .min(1)
      .max(6),
  })
  .strict()
export type SourceKind = z.infer<typeof sourceKindSchema>

/** A binding slot on a composite widget: which shapes may fill it, and how many. */
export const roleSchema = z
  .object({
    label: z.string().min(1).max(48),
    help: z.string().max(240).optional(),
    min: z.int().min(0).max(16).default(1),
    max: z.int().min(1).max(16).default(8),
    kinds: z.record(identifier, sourceKindSchema),
  })
  .strict()
export type Role = z.infer<typeof roleSchema>

const itemPath = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9.]{0,62}$/)

/**
 * Merges N source streams into one widget, in fixed order: concat, distinct, sort, limit.
 * Deliberately not the DSL, which runs per source before merging. `partial` keeps one dead
 * source from blanking the ones that answered.
 */
export const composeSchema = z
  .object({
    /** Dotted paths into an item; `badge.iso` is how a calendar sorts by instant. */
    sortBy: z
      .array(
        z.object({
          path: itemPath,
          direction: z.enum(['asc', 'desc']).default('asc'),
        }),
      )
      .max(3)
      .default([]),
    /**
     * Keys that together identify one item across sources; a single path such as `title` is
     * usually too coarse.
     */
    distinctBy: z.array(itemPath).min(1).max(3).optional(),
    limit: z.int().min(1).max(50).default(20),
    partial: z.boolean().default(true),
  })
  .strict()
export type Compose = z.infer<typeof composeSchema>

const commonManifest = {
  manifestVersion: z.literal(1),
  id: identifier,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  displayName: z.string().min(1).max(48),
  category: z.enum(CATEGORIES),
  /**
   * What kind of thing this is, as distinct from `category`'s domain; the editor groups by it.
   * Defaulted so existing manifests need not change.
   */
  kind: z.enum(['widget', 'bookmark', 'tool']).default('widget'),
  /** A slug into the bundled icon pack. Never a URL: that would be a tracking pixel. */
  icon: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/),
  docs: z.url().optional(),
  config: z.array(fieldSchema).max(24).default([]),
  presentation: z.object({ template: z.enum(TEMPLATES) }),
  poll: z.object({
    defaultIntervalMs: z.int().min(5_000).max(86_400_000),
    minIntervalMs: z.int().min(1_000).max(86_400_000),
  }),
  requires: requiresSchema,
}

/** One target, one projection: what almost every integration is. */
export const singleManifestSchema = z
  .object({
    ...commonManifest,
    target: z.object({
      fields: z.array(fieldSchema).max(16).default([]),
      auth: authSchema,
    }),
    operations: z.record(fieldName, operationSchema),
    projection: nodeSchema,
  })
  .strict()
export type SingleManifest = z.infer<typeof singleManifestSchema>

/** N bound targets of possibly different shapes, merged into one board tile. */
export const compositeManifestSchema = z
  .object({
    ...commonManifest,
    roles: z.record(fieldName, roleSchema),
    compose: composeSchema,
  })
  .strict()
export type CompositeManifest = z.infer<typeof compositeManifestSchema>

// Plain union: the two shapes have disjoint required keys, so `roles` already discriminates.
export const manifestSchema = z.union([singleManifestSchema, compositeManifestSchema])

export type Manifest = z.infer<typeof manifestSchema>

export function isComposite(manifest: Manifest): manifest is CompositeManifest {
  return 'roles' in manifest
}

/**
 * On failure, reports issues against the branch the document already looks like; a bare union
 * only says `(root): Invalid input`.
 */
export function parseManifest(
  raw: unknown,
):
  | { ok: true; manifest: Manifest }
  | { ok: false; shape: 'single' | 'composite'; issues: ManifestProblem[] } {
  const united = manifestSchema.safeParse(raw)
  if (united.success) return { ok: true, manifest: united.data }

  const looksComposite =
    raw !== null && typeof raw === 'object' && ('roles' in raw || 'compose' in raw)
  const branch = looksComposite ? compositeManifestSchema : singleManifestSchema
  const detailed = branch.safeParse(raw)
  const issues = detailed.success
    ? // The branch parsed but the union did not: the document satisfies both shapes at once.
      [
        {
          path: '(root)',
          message:
            'a manifest declares either target/operations/projection or roles/compose, never both',
        },
      ]
    : detailed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      }))

  return { ok: false, shape: looksComposite ? 'composite' : 'single', issues }
}

export function sourceKinds(
  manifest: CompositeManifest,
): { role: string; kind: string; source: SourceKind }[] {
  return Object.entries(manifest.roles).flatMap(([role, definition]) =>
    Object.entries(definition.kinds).map(([kind, source]) => ({ role, kind, source })),
  )
}

/**
 * Catalog CI asserts this equals the declared `requires` block, and the client re-derives it
 * rather than trusting the catalog.
 */
export function deriveRequires(manifest: Manifest): Requires {
  const opcodes = new Set<string>()
  const authKinds = new Set<AuthKind>()
  const fetchKinds = new Set<Decoder>()

  if (isComposite(manifest)) {
    for (const { source } of sourceKinds(manifest)) {
      authKinds.add(source.auth.kind)
      fetchKinds.add(source.operation.decode)
      for (const emit of source.emits)
        for (const op of usedOpcodes(emit.projection)) opcodes.add(op)
    }
  } else {
    authKinds.add(manifest.target.auth.kind)
    for (const operation of Object.values(manifest.operations)) {
      fetchKinds.add(operation.decode)
    }
    for (const op of usedOpcodes(manifest.projection)) opcodes.add(op)
  }

  return {
    templates: [manifest.presentation.template],
    opcodes: [...opcodes].sort(),
    authKinds: [...authKinds].sort(),
    fetchKinds: [...fetchKinds].sort(),
  }
}

export type ManifestProblem = { readonly path: string; readonly message: string }

/** Checks the schema cannot express; run on every catalog pull request. */
export function auditManifest(manifest: Manifest): ManifestProblem[] {
  const problems: ManifestProblem[] = []

  if (isComposite(manifest)) {
    auditComposite(manifest, problems)
  } else {
    auditSurface(
      { fields: manifest.target.fields, auth: manifest.target.auth },
      manifest.operations,
      'target',
      'operations',
      problems,
    )
  }

  if (manifest.poll.minIntervalMs > manifest.poll.defaultIntervalMs) {
    problems.push({ path: 'poll', message: 'minIntervalMs is greater than defaultIntervalMs' })
  }

  const derived = deriveRequires(manifest)
  const declared = manifest.requires
  for (const key of ['templates', 'opcodes', 'authKinds', 'fetchKinds'] as const) {
    const a = [...declared[key]].sort().join(',')
    const b = [...derived[key]].sort().join(',')
    if (a !== b) {
      problems.push({
        path: `requires.${key}`,
        message: `declared [${a}] but the manifest actually uses [${b}]`,
      })
    }
  }

  return problems
}

// Secret rules for one authenticating surface, shared by the single-target shape and every
// composite source kind so there is no second, laxer path.
function auditSurface(
  surface: { fields: readonly Field[]; auth: Auth },
  operations: Record<string, Operation>,
  fieldsPath: string,
  operationsPath: string,
  problems: ManifestProblem[],
): void {
  const declaredSecrets = new Set(
    surface.fields.filter((f) => f.kind === 'secret').map((f) => f.name),
  )

  const authText = JSON.stringify(surface.auth)
  for (const [, name] of authText.matchAll(secretRef)) {
    if (!declaredSecrets.has(name as string)) {
      problems.push({ path: `${fieldsPath}.auth`, message: `references undeclared secret ${name}` })
    }
  }

  for (const [opName, operation] of Object.entries(operations)) {
    const exposed = JSON.stringify({
      path: operation.path,
      query: operation.query,
      headers: operation.headers,
    })
    if (exposed.search(secretRef) !== -1) {
      problems.push({
        path: `${operationsPath}.${opName}`,
        message: `a secret may only be referenced from ${fieldsPath}.auth, never in a path, query or header`,
      })
    }
  }
}

function auditComposite(manifest: CompositeManifest, problems: ManifestProblem[]): void {
  const roles = Object.entries(manifest.roles)
  if (roles.length === 0) {
    problems.push({ path: 'roles', message: 'a composite widget declares at least one role' })
  }

  for (const [roleName, role] of roles) {
    if (role.min > role.max) {
      problems.push({
        path: `roles.${roleName}`,
        message: `min ${role.min} exceeds max ${role.max}`,
      })
    }
    const kinds = Object.entries(role.kinds)
    if (kinds.length === 0) {
      problems.push({
        path: `roles.${roleName}.kinds`,
        message: 'a role accepts at least one kind',
      })
    }

    for (const [kindName, source] of kinds) {
      const where = `roles.${roleName}.kinds.${kindName}`
      auditSurface(source, { operation: source.operation }, where, where, problems)

      const emitIds = new Set<string>()
      for (const emit of source.emits) {
        if (emitIds.has(emit.id)) {
          problems.push({ path: `${where}.emits`, message: `duplicate emit id ${emit.id}` })
        }
        emitIds.add(emit.id)
      }
    }
  }

  // A sort key naming no item field would silently yield arrival order.
  for (const key of manifest.compose.sortBy) {
    const head = key.path.split('.')[0] as string
    if (!ITEM_FIELDS.has(head)) {
      problems.push({
        path: 'compose.sortBy',
        message: `"${key.path}" does not address an item field (${[...ITEM_FIELDS].sort().join(', ')})`,
      })
    }
  }
  for (const path of manifest.compose.distinctBy ?? []) {
    if (!ITEM_FIELDS.has(path.split('.')[0] as string)) {
      problems.push({
        path: 'compose.distinctBy',
        message: `"${path}" does not address an item field`,
      })
    }
  }
}

/** The render contract's item keys, restated here so compose can be checked without importing it. */
const ITEM_FIELDS = new Set(['title', 'subtitle', 'badge', 'icon', 'href', 'progress'])
