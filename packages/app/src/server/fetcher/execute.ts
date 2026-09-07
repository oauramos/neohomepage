import type { Json, Manifest, Operation } from '@neohomepage/catalog-schema'
import { runProjection } from '@neohomepage/catalog-schema'
import { decode, DecodeError } from '../decode/index.ts'
import { applyAuth, type AuthContext } from './auth.ts'
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
  readonly manifest: Manifest
  readonly operation: string
  readonly target: TargetBinding
  readonly config: Readonly<Record<string, unknown>>
  readonly auth: AuthContext
  readonly now: string
  readonly limits?: Partial<FetchLimits>
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
  const expectedPathname = `${basePath}${path}`

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

export async function executeOperation(input: ExecuteInput): Promise<ExecuteResult> {
  const operation = input.manifest.operations[input.operation]
  if (operation === undefined) {
    return { ok: false, code: 'unknown-operation', message: `no operation "${input.operation}"` }
  }

  try {
    const applied = applyAuth(input.manifest.target.auth, input.auth)
    const url = buildOperationUrl(operation, input.target, input.config, applied.query)

    const response = await fetchUpstream({
      url,
      method: operation.method,
      headers: { ...operation.headers, ...applied.headers },
      allowLoopback: input.target.allowLoopback ?? false,
      insecureSkipVerify: input.target.insecureSkipVerify ?? false,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    })

    if (response.status >= 400) {
      return {
        ok: false,
        code: `http-${response.status}`,
        message: `the target answered ${response.status}`,
      }
    }

    const decoded = decode(operation.decode, response.body)
    const projected = runProjection(input.manifest.projection, {
      source: decoded,
      options: input.config as Record<string, Json>,
      targetBaseUrl: input.target.origin,
      now: input.now,
    })
    if (!projected.ok) return { ok: false, code: 'projection', message: projected.reason }

    return { ok: true, projection: projected.value, status: response.status }
  } catch (error) {
    if (error instanceof OperationError || error instanceof UpstreamError) {
      return { ok: false, code: error.code, message: error.message }
    }
    if (error instanceof DecodeError) {
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
}
