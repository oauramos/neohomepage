import type { Auth, Json, Operation, SingleManifest, SourceKind } from '@neohomepage/catalog-schema'
import { isJsonArray, runProjection } from '@neohomepage/catalog-schema'
import { decode, DecodeError } from '../decode/index.ts'
import { applyAuth, MissingSecretError, type AuthContext } from './auth.ts'
import { SessionExchangeError, SessionManager } from './session.ts'
import { fetchUpstream, UpstreamError } from './client.ts'
import { assertUrlShape, BlockedAddressError } from './policy.ts'

/**
 * Turns a widget instance into one upstream request and one projection. The browser and the MCP
 * server never name a URL: the server resolves instance -> target -> manifest -> path template,
 * then asserts the URL it dials has exactly the origin and pathname it computed (not a blocklist).
 */

export class OperationError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OperationError'
    this.code = code
  }
}

const HOLE = /\{\{(config|secret):([A-Za-z][A-Za-z0-9]*)\}\}/g

/**
 * Fills a manifest template with instance config, percent-encoding every value. A secret is
 * refused rather than encoded: it would land in access, proxy and browser logs. The schema
 * rejects this too; this is the runtime half of the same rule.
 */
function fillOperationTemplate(
  template: string,
  config: Readonly<Record<string, unknown>>,
  where: string,
): string {
  return template.replace(HOLE, (_match, kind: string, name: string) => {
    if (kind === 'secret') {
      throw new OperationError(
        'secret-in-url',
        `a secret may only be used in target.auth, but ${where} references one`,
      )
    }
    const value = config[name]
    return value === undefined ? '' : encodeURIComponent(String(value))
  })
}

export type TargetBinding = {
  readonly origin: string
  readonly basePath: string
  readonly allowLoopback?: boolean
  readonly insecureSkipVerify?: boolean
}

export type ExecuteInput = {
  readonly manifest: SingleManifest
  readonly operation: string
  readonly target: TargetBinding
  readonly config: Readonly<Record<string, unknown>>
  readonly auth: AuthContext
  readonly now: string
  /** Overridable so a test drives its own session pool instead of the process-wide one. */
  readonly sessions?: SessionManager
}

export type ExecuteResult =
  | { readonly ok: true; readonly projection: Json; readonly status: number }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Build the URL for an operation and prove it is the one that was computed. */
export function buildOperationUrl(
  operation: Operation,
  target: TargetBinding,
  config: Readonly<Record<string, unknown>>,
  authQuery: Readonly<Record<string, string>> = {},
): URL {
  const base = assertUrlShape(target.origin)
  const basePath = target.basePath.replace(/\/+$/, '')
  const path = fillOperationTemplate(operation.path, config, 'the operation path')
  // A bare "/" means the target's base path exactly, so an iCalendar feed can keep its whole path
  // in the target; a config hole would percent-encode /dav/cal.ics into /dav%2Fcal.ics.
  const expectedPathname = path === '/' ? (basePath === '' ? '/' : basePath) : `${basePath}${path}`

  const url = new URL(expectedPathname, base)
  for (const [key, value] of Object.entries(operation.query ?? {})) {
    url.searchParams.set(key, fillOperationTemplate(value, config, `query parameter "${key}"`))
  }
  for (const [key, value] of Object.entries(authQuery)) url.searchParams.set(key, value)

  // Refuse to dial anything other than the origin and pathname computed above.
  if (url.origin !== base.origin) {
    throw new OperationError('origin-mismatch', 'the computed URL left the target origin')
  }
  if (url.pathname !== expectedPathname) {
    throw new OperationError(
      'path-mismatch',
      'the computed URL path does not match the operation template',
    )
  }
  return url
}

/**
 * Everything up to and including decode, shared by both entry points so the origin-and-pathname
 * assertion happens in one place.
 */
async function dial(
  operation: Operation,
  auth: { readonly auth: Auth; readonly context: AuthContext },
  target: TargetBinding,
  config: Readonly<Record<string, unknown>>,
  now: string,
  sessions: SessionManager,
): Promise<
  { ok: true; decoded: Json; status: number } | { ok: false; code: string; message: string }
> {
  // For `session-exchange` this may perform the login request; every other kind is a table lookup.
  const prepare = async () => {
    if (auth.auth.kind !== 'session-exchange') {
      return { sessionKey: null, applied: applyAuth(auth.auth, auth.context) }
    }
    const exchanged = await sessions.authorize({
      auth: auth.auth,
      origin: target.origin,
      basePath: target.basePath,
      context: auth.context,
      allowLoopback: target.allowLoopback ?? false,
      insecureSkipVerify: target.insecureSkipVerify ?? false,
    })
    return { sessionKey: exchanged.key, applied: exchanged.applied }
  }

  // A `{{config:name}}` hole reads the widget options and, beneath them, the target's non-secret
  // fields (Subsonic sends the target's username and salt as query parameters).
  const templateScope = { ...auth.context.config, ...config }

  const request = async (applied: {
    headers: Readonly<Record<string, string>>
    query: Readonly<Record<string, string>>
  }) =>
    fetchUpstream({
      url: buildOperationUrl(operation, target, templateScope, applied.query),
      method: operation.method,
      headers: { ...operation.headers, ...applied.headers },
      allowLoopback: target.allowLoopback ?? false,
      insecureSkipVerify: target.insecureSkipVerify ?? false,
    })

  const first = await prepare()
  let response = await request(first.applied)

  // An expired session presents as 401/403. Exactly one re-login: if a fresh session is also
  // refused the credential is wrong, and retrying further is how a stale cookie becomes an IP ban.
  if (first.sessionKey !== null && (response.status === 401 || response.status === 403)) {
    sessions.invalidate(first.sessionKey)
    response = await request((await prepare()).applied)
  }

  if (response.status >= 400) {
    return {
      ok: false,
      code: `http-${response.status}`,
      message: `the target answered ${response.status}`,
    }
  }

  return {
    ok: true,
    decoded: decode(operation.decode, response.body, { now }),
    status: response.status,
  }
}

// Process-wide so widgets on the same service share one login; tests pass their own.
const sessions = new SessionManager({ now: () => Date.now() })

/** Map a thrown error onto the same result shape, so no caller has to know the error classes. */
function asFailure(error: unknown): { ok: false; code: string; message: string } {
  if (
    error instanceof OperationError ||
    error instanceof UpstreamError ||
    error instanceof DecodeError ||
    error instanceof SessionExchangeError
  ) {
    return { ok: false, code: error.code, message: error.message }
  }
  if (error instanceof MissingSecretError) {
    return { ok: false, code: 'missing-credential', message: error.message }
  }
  if (error instanceof BlockedAddressError) {
    return { ok: false, code: 'blocked-address', message: error.message }
  }
  return { ok: false, code: 'unreachable', message: 'the target could not be reached' }
}

export async function executeOperation(input: ExecuteInput): Promise<ExecuteResult> {
  const operation = input.manifest.operations[input.operation]
  if (operation === undefined) {
    return { ok: false, code: 'unknown-operation', message: `no operation "${input.operation}"` }
  }

  try {
    const dialled = await dial(
      operation,
      { auth: input.manifest.target.auth, context: input.auth },
      input.target,
      input.config,
      input.now,
      input.sessions ?? sessions,
    )
    if (!dialled.ok) return dialled

    const projected = runProjection(input.manifest.projection, {
      source: dialled.decoded,
      options: input.config as Record<string, Json>,
      targetBaseUrl: input.target.origin,
      now: input.now,
    })
    if (!projected.ok) return { ok: false, code: 'projection', message: projected.reason }

    return { ok: true, projection: projected.value, status: dialled.status }
  } catch (error) {
    return asFailure(error)
  }
}

export type SourceInput = {
  readonly source: SourceKind
  readonly target: TargetBinding
  readonly config: Readonly<Record<string, unknown>>
  readonly auth: AuthContext
  readonly now: string
  readonly sessions?: SessionManager
}

/**
 * Runs one bound source of a composite widget: one request, N emitted item streams. An emit that
 * does not evaluate to an array is dropped rather than failing the source: the catalog runner
 * rejects that shape at publish time, so at runtime it means a manifest from a newer catalog.
 */
export async function executeSource(input: SourceInput): Promise<ExecuteResult> {
  try {
    const dialled = await dial(
      input.source.operation,
      { auth: input.source.auth, context: input.auth },
      input.target,
      input.config,
      input.now,
      input.sessions ?? sessions,
    )
    if (!dialled.ok) return dialled

    const items: Json[] = []
    for (const emit of input.source.emits) {
      const projected = runProjection(emit.projection, {
        source: dialled.decoded,
        options: input.config as Record<string, Json>,
        targetBaseUrl: input.target.origin,
        now: input.now,
      })
      if (!projected.ok) return { ok: false, code: 'projection', message: projected.reason }
      if (isJsonArray(projected.value)) items.push(...projected.value)
    }

    return { ok: true, projection: { items }, status: dialled.status }
  } catch (error) {
    return asFailure(error)
  }
}
