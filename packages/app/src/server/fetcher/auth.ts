import type { Auth } from '@neohomepage/catalog-schema'

/**
 * Declarative authentication.
 *
 * gethomepage grows a credential branch per integration — a long if/else chain that every new
 * widget has to be threaded into. Here the manifest names one of five kinds and this table applies
 * it, so adding an integration touches no shared code and a reviewer reads one JSON object.
 *
 * The resolved credential exists only inside the outbound request. It is never returned to a
 * caller that could serialise it, never logged, and never reachable from a projection.
 */

export class MissingSecretError extends Error {
  readonly secretName: string

  constructor(secretName: string) {
    super(`credential "${secretName}" is not set`)
    this.name = 'MissingSecretError'
    this.secretName = secretName
  }
}

export type AuthContext = {
  /** Field name to secret value. Resolved by the vault immediately before the request. */
  readonly secrets: Readonly<Record<string, string>>
  /** Non-secret target and instance fields, for templates like `{{config:username}}`. */
  readonly config: Readonly<Record<string, string | number | boolean>>
}

export type AppliedAuth = {
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

const TEMPLATE = /\{\{(secret|config):([A-Za-z][A-Za-z0-9]*)\}\}/g

/**
 * Fill a template from the manifest.
 *
 * A missing secret throws rather than interpolating an empty string. Sending `X-Api-Key:` with no
 * value produces a confusing 401 from the service and sends the user hunting through their reverse
 * proxy; "credential not set" points at the actual problem.
 */
export function fillTemplate(template: string, context: AuthContext): string {
  return template.replace(TEMPLATE, (_match, kind: string, name: string) => {
    if (kind === 'secret') {
      const value = context.secrets[name]
      if (value === undefined || value === '') throw new MissingSecretError(name)
      return value
    }
    const value = context.config[name]
    return value === undefined ? '' : String(value)
  })
}

export function applyAuth(auth: Auth, context: AuthContext): AppliedAuth {
  switch (auth.kind) {
    case 'none':
      return { headers: {}, query: {} }

    case 'header':
      return { headers: { [auth.header]: fillTemplate(auth.value, context) }, query: {} }

    case 'basic': {
      const username = fillTemplate(auth.username, context)
      const password = fillTemplate(auth.password, context)
      const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
      return { headers: { authorization: `Basic ${encoded}` }, query: {} }
    }

    case 'query':
      // Allowed because some services offer nothing else, and the reason a query string is never
      // logged and never returned to the browser.
      return { headers: {}, query: { [auth.param]: fillTemplate(auth.value, context) } }

    case 'session-exchange':
      // Handled by the session manager, which must make a login request first. Returning empty
      // here rather than throwing keeps applyAuth total; the caller checks the kind.
      return { headers: {}, query: {} }

    default: {
      const exhaustive: never = auth
      throw new Error(`unhandled auth kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])

/**
 * Redact a header set for logging.
 *
 * Headers auth produces are redacted by name, and anything else that merely *looks* like a
 * credential is redacted too — a manifest names its own header, so an allowlist of known names
 * would miss whatever the next integration invents.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    const sensitive =
      SENSITIVE_HEADERS.has(lower) ||
      ['key', 'token', 'secret', 'auth', 'password', 'sid'].some((hint) => lower.includes(hint))
    out[name] = sensitive ? '[redacted]' : value
  }
  return out
}
