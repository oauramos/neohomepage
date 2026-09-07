import type { Json, Operation, SingleManifest, SourceKind } from '@neohomepage/catalog-schema'
import { isJsonArray, runProjection } from '@neohomepage/catalog-schema'
import { decode, DecodeError } from '../decode/index.ts'
import { applyAuth, type AuthContext } from './auth.ts'
import { SessionExchangeError, SessionManager } from './session.ts'
import { fetchUpstream, UpstreamError, type FetchLimits } from './client.ts'
import { assertUrlShape } from './policy.ts'

/**
 * Turn a widget instance into one upstream request and one projection.
 *
 * This is where the product's central invariant lives:
 *
 *   The browser and the MCP server never name a URL, path, header or HTTP method.
 *
 * A caller asks to refresh a widget by id. The server resolves instance -> target -> manifest ->
 * a literal path template with typed, encoded parameters, and then asserts that the URL it is
 * about to dial has exactly the origin and pathname it just computed. That equality check — not a
 * character blocklist — is what defeats forward-slash traversal, the backslash bypass that broke
 * gethomepage's first fix the same day, the %23 fragment trick, and the omitted-parameter
 * early-return that produced GHSA-669x-4pg4-w24r.
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
 * Fill a manifest template with instance config, percent-encoding every value.
 *
 * A secret is refused here rather than encoded: credentials belong in `target.auth` and nowhere
 * else, because a value interpolated into a path or a query string ends up in access logs, proxy
 * logs and browser history. The manifest schema rejects this too; this is the runtime half of the
 * same rule, so a manifest that slipped through an older validator still cannot do it.
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
  readonly limits?: Partial<FetchLimits>
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
  // A bare "/" means "the target's base path, exactly". That is what lets an iCalendar feed put
  // its whole path in the target — where a user-supplied path belongs — instead of forcing it
  // through a config hole, where percent-encoding would turn /dav/cal.ics into /dav%2Fcal.ics.
  const expectedPathname = path === '/' ? (basePath === '' ? '/' : basePath) : `${basePath}${path}`

  const url = new URL(expectedPathname, base)
  for (const [key, value] of Object.entries(operation.query ?? {})) {
    url.searchParams.set(key, fillOperationTemplate(value, config, `query parameter "${key}"`))
  }
  for (const [key, value] of Object.entries(authQuery)) url.searchParams.set(key, value)

  // The invariant. If interpolation, encoding or URL parsing produced anything other than the
  // path we computed against the target we were bound to, we do not dial it.
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
 * Everything up to and including decode, shared by both entry points.
 *
 * A composite's source kinds authenticate and dial through exactly this function, so there is one
 * place where the origin-and-pathname assertion happens. A second, parallel request path for
 * multi-source widgets is precisely how a hardened codebase grows a soft underside.
 */
async function dial(
  operation: Operation,
  auth: { readonly auth: Parameters<typeof applyAuth>[0]; readonly context: AuthContext },
  target: TargetBinding,
  config: Readonly<Record<string, unknown>>,
  now: string,
  limits: Partial<FetchLimits> | undefined,
  sessions: SessionManager,
): Promise<
  { ok: true; decoded: Json; status: number } | { ok: false; code: string; message: string }
> {
  /**
   * Resolve auth for one attempt. For `session-exchange` this may perform the login request; for
   * every other kind it is a pure table lookup.
   */
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
      ...(limits === undefined ? {} : { limits }),
    })
    return { sessionKey: exchanged.key, applied: exchanged.applied }
  }

  const request = async (applied: {
    headers: Readonly<Record<string, string>>
    query: Readonly<Record<string, string>>
  }) =>
    fetchUpstream({
      url: buildOperationUrl(operation, target, config, applied.query),
      method: operation.method,
      headers: { ...operation.headers, ...applied.headers },
      allowLoopback: target.allowLoopback ?? false,
      insecureSkipVerify: target.insecureSkipVerify ?? false,
      ...(limits === undefined ? {} : { limits }),
    })

  const first = await prepare()
  let response = await request(first.applied)

  // A session the service has already expired presents as 401/403 on an ordinary request. Exactly
  // one re-login, and then the status stands: if a *fresh* session is also refused the credential
  // is wrong, and reporting that as "http-403" tells the user something "session-rejected" would
  // hide. Retrying past this is also how a stale cookie becomes an IP ban.
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

/**
 * One session pool for the process.
 *
 * Module-level rather than per-call so six widgets on the same qBittorrent share one login —
 * which is the whole point of the kind. Tests pass their own.
 */
export const sessions = new SessionManager({ now: () => Date.now() })

/** Map a thrown error onto the same result shape, so no caller has to know the error classes. */
function asFailure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof OperationError || error instanceof UpstreamError) {
    return { ok: false, code: error.code, message: error.message }
  }
  if (error instanceof DecodeError || error instanceof SessionExchangeError) {
    return { ok: false, code: error.code, message: error.message }
  }
  if (error instanceof Error && error.name === 'MissingSecretError') {
    return { ok: false, code: 'missing-credential', message: error.message }
  }
  if (error instanceof Error && error.name === 'BlockedAddressError') {
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
      input.limits,
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
  readonly limits?: Partial<FetchLimits>
  readonly sessions?: SessionManager
}

/**
 * Run one bound source of a composite widget: ONE request, N emitted item streams.
 *
 * The fan-out lives here rather than in the DSL because it is the only reason a `flatMap` opcode
 * would have had to exist. Radarr publishes three dates per film; three emits over one decoded
 * response produce three streams and one HTTP request, and the scheduler never learns about it.
 *
 * An emit that does not evaluate to an array is dropped rather than failing the source: the
 * catalog runner rejects that shape at publish time, so at runtime it means a manifest from a
 * newer catalog than this build, and the other emits still have something to show.
 */
export async function executeSource(input: SourceInput): Promise<ExecuteResult> {
  try {
    const dialled = await dial(
      input.source.operation,
      { auth: input.source.auth, context: input.auth },
      input.target,
      input.config,
      input.now,
      input.limits,
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
