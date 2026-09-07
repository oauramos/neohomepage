import { z } from 'zod'
import { nodeSchema, type Node } from './dsl/node.ts'
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
    tokenPath: z.string().max(120).optional(),
    sendAs: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('header'),
        header: z.string().max(48),
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
  .regex(/^\/[A-Za-z0-9._~\-/{}]*$/, 'must be an absolute path with only {config.field} holes')

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

export const manifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: identifier,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    displayName: z.string().min(1).max(48),
    category: identifier,
    /** A slug into the bundled icon pack. Never a URL: that would be a tracking pixel. */
    icon: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/),
    docs: z.url().optional(),
    target: z.object({
      fields: z.array(fieldSchema).max(16).default([]),
      auth: authSchema,
    }),
    config: z.array(fieldSchema).max(24).default([]),
    operations: z.record(fieldName, operationSchema),
    projection: nodeSchema,
    presentation: z.object({ template: z.enum(TEMPLATES) }),
    poll: z.object({
      defaultIntervalMs: z.int().min(5_000).max(86_400_000),
      minIntervalMs: z.int().min(1_000).max(86_400_000),
    }),
    requires: requiresSchema,
  })
  .strict()

export type Manifest = z.infer<typeof manifestSchema>

/**
 * Derive what a manifest actually needs. The catalog's CI asserts this equals the declared
 * `requires` block, and the client re-derives it independently rather than trusting the catalog —
 * a hand-maintained requirements list drifts within weeks, and that drift *is* the
 * "installs fine, then renders nothing" bug.
 */
export function deriveRequires(manifest: {
  target: { auth: { kind: AuthKind } }
  operations: Record<string, { decode?: Decoder }>
  projection: Node
  presentation: { template: Template }
}): Requires {
  return {
    templates: [manifest.presentation.template],
    opcodes: [...usedOpcodes(manifest.projection)].sort(),
    authKinds: [manifest.target.auth.kind],
    fetchKinds: [
      ...new Set(Object.values(manifest.operations).map((op) => op.decode ?? 'json')),
    ].sort(),
  }
}

export type ManifestProblem = { readonly path: string; readonly message: string }

/**
 * Checks the schema cannot express, run on every catalog pull request.
 * These are the rules that keep a hostile manifest no more dangerous than a mistyped base URL.
 */
export function auditManifest(manifest: Manifest): ManifestProblem[] {
  const problems: ManifestProblem[] = []
  const declaredSecrets = new Set(
    manifest.target.fields.filter((f) => f.kind === 'secret').map((f) => f.name),
  )

  const authText = JSON.stringify(manifest.target.auth)
  for (const [, name] of authText.matchAll(secretRef)) {
    if (!declaredSecrets.has(name as string)) {
      problems.push({ path: 'target.auth', message: `references undeclared secret ${name}` })
    }
  }

  for (const [opName, operation] of Object.entries(manifest.operations)) {
    const surface = JSON.stringify({
      path: operation.path,
      query: operation.query,
      headers: operation.headers,
    })
    if (secretRef.test(surface)) {
      problems.push({
        path: `operations.${opName}`,
        message:
          'a secret may only be referenced from target.auth, never in a path, query or header',
      })
    }
    secretRef.lastIndex = 0
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
