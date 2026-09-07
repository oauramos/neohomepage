import { z } from 'zod'
import { nodeSchema } from './dsl/node.ts'
import { usedOpcodes } from './dsl/walk.ts'

/**
 * A widget manifest: the single hand-written artefact per integration.
 *
 * Four things are derived from it and therefore cannot drift — the edit form, the MCP tool schema,
 * the proxy's endpoint allowlist, and the secret-stripping rule. The catalog contains no code, so
 * everything a widget can do has to be expressible here, and every field is reviewed as data.
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

/**
 * A secret may be referenced ONLY from an auth template. Never from a path, never from a query
 * value: a credential in a URL ends up in access logs, proxy logs and browser history, and it
 * gives a hostile manifest a channel to exfiltrate one.
 */
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
    // Pi-hole v6 returns session.sid from POST /api/auth; qBittorrent returns a cookie. A
    // stateless-only auth model cannot express either, which is why this kind exists.
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
  // The colon is for the unified `{{config:name}}` hole syntax, the same form `auth` uses. The
  // first version of this regex was written for an earlier `{config.field}` spelling and silently
  // rejected every path template that actually interpolated anything.
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
 * A source kind: one shape of upstream a role will accept, declared self-containedly.
 *
 * It is a whole mini-manifest — its own fields, its own auth, its own single operation — because
 * a unified calendar binds a Sonarr and an ICS feed at the same time, and those authenticate
 * differently. Pointing at another manifest's operation instead would make every calendar widget
 * break the day someone renames a path in the Sonarr manifest.
 *
 * `emits` is the fan-out, and it is where one HTTP request becomes several streams: Radarr's
 * in-cinemas, physical and digital dates are three emits over one `/api/v3/calendar` response,
 * not three requests and not a `flatMap` opcode.
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

/**
 * How N streams become one widget.
 *
 * Six knobs, all total, all applied in a fixed order (concat, distinct, sort, limit). Composition
 * is deliberately not the DSL: the DSL runs per source, before anything is merged, and giving the
 * merge step its own expression language would double the surface a hostile manifest can reach.
 *
 * `partial` is the calendar's whole reason for existing at home: one dead Radarr must not blank
 * out the four calendars that answered.
 */
export const composeSchema = z
  .object({
    /** Dotted paths into an item; `badge.iso` is how a calendar sorts by instant. */
    sortBy: z
      .array(
        z.object({
          path: z
            .string()
            .max(64)
            .regex(/^[A-Za-z][A-Za-z0-9.]{0,62}$/),
          direction: z.enum(['asc', 'desc']).default('asc'),
        }),
      )
      .max(3)
      .default([]),
    /**
     * Keys that together identify one item, for dropping duplicates across sources.
     *
     * An array, not a single path, because one path is almost always the wrong granularity. The
     * calendar shipped with `distinctBy: "title"` and every episode of a series after the first
     * vanished — they share a title, and only the instant tells them apart.
     */
    distinctBy: z
      .array(
        z
          .string()
          .max(64)
          .regex(/^[A-Za-z][A-Za-z0-9.]{0,62}$/),
      )
      .min(1)
      .max(3)
      .optional(),
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
  category: identifier,
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

/**
 * A plain union rather than a discriminator field.
 *
 * The two shapes have disjoint required keys, so `roles` already discriminates. Adding a
 * `kind: "single"` line to every manifest to please `discriminatedUnion` would be a keyword that
 * only exists to restate what the body already says.
 */
export const manifestSchema = z.union([singleManifestSchema, compositeManifestSchema])

export type Manifest = z.infer<typeof manifestSchema>

/** Narrowing that the rest of the server switches on. */
export function isComposite(manifest: Manifest): manifest is CompositeManifest {
  return 'roles' in manifest
}

/**
 * Parse a manifest and, on failure, say which branch it was judged against.
 *
 * A bare union reports `(root): Invalid input` — literally true and useless to whoever is writing
 * the file. Choosing the branch the document already looks like turns that into "your fourth emit
 * has no projection", which is the difference between a contributor fixing a PR in a minute and
 * abandoning it.
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
    ? // The branch parsed but the union did not, which can only mean the document satisfies both
      // sets of required keys — a manifest that is single-source AND composite at once.
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

/** Every source kind in a composite, flattened with the role it belongs to. */
export function sourceKinds(
  manifest: CompositeManifest,
): { role: string; kind: string; source: SourceKind }[] {
  return Object.entries(manifest.roles).flatMap(([role, definition]) =>
    Object.entries(definition.kinds).map(([kind, source]) => ({ role, kind, source })),
  )
}

/**
 * Derive what a manifest actually needs. The catalog's CI asserts this equals the declared
 * `requires` block, and the client re-derives it independently rather than trusting the catalog —
 * a hand-maintained requirements list drifts within weeks, and that drift *is* the
 * "installs fine, then renders nothing" bug.
 */
export function deriveRequires(manifest: Manifest): Requires {
  const opcodes = new Set<string>()
  const authKinds = new Set<AuthKind>()
  const fetchKinds = new Set<Decoder>()

  if (isComposite(manifest)) {
    for (const { source } of sourceKinds(manifest)) {
      authKinds.add(source.auth.kind)
      fetchKinds.add(source.operation.decode ?? 'json')
      for (const emit of source.emits)
        for (const op of usedOpcodes(emit.projection)) opcodes.add(op)
    }
  } else {
    authKinds.add(manifest.target.auth.kind)
    for (const operation of Object.values(manifest.operations)) {
      fetchKinds.add(operation.decode ?? 'json')
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

/**
 * Checks the schema cannot express, run on every catalog pull request.
 * These are the rules that keep a hostile manifest no more dangerous than a mistyped base URL.
 */
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

/**
 * The secret rules, applied to one authenticating surface.
 *
 * Shared between the single-target shape and every source kind of a composite, because a
 * composite that authenticated by a second, laxer code path would be exactly the hole this audit
 * exists to close.
 */
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
    if (secretRef.test(exposed)) {
      problems.push({
        path: `${operationsPath}.${opName}`,
        message:
          'a secret may only be referenced from target.auth, never in a path, query or header',
      })
    }
    secretRef.lastIndex = 0
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
      auditSurface(source, { operation: source.operation }, where, `${where}.operation`, problems)

      const emitIds = new Set<string>()
      for (const emit of source.emits) {
        if (emitIds.has(emit.id)) {
          problems.push({ path: `${where}.emits`, message: `duplicate emit id ${emit.id}` })
        }
        emitIds.add(emit.id)
      }
    }
  }

  // A composite renders `items`, so a sort key that names nothing an item has would silently
  // produce arrival order — the failure mode being "my calendar is not in date order".
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
