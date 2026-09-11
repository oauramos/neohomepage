import type { Auth } from '@neohomepage/catalog-schema'

/**
 * Declarative authentication: a manifest names one of five kinds and this module applies it. The
 * resolved credential exists only inside the outbound request; it is never returned, logged or
 * projected.
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
  readonly secrets: Readonly<Record<string, string>>
  readonly config: Readonly<Record<string, string | number | boolean>>
}

export type AppliedAuth = {
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

const TEMPLATE = /\{\{(secret|config):([A-Za-z][A-Za-z0-9]*)\}\}/g

/**
 * A missing secret throws rather than interpolating an empty string, which would only produce a
 * confusing 401 upstream.
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
      // Query strings can carry a credential, so they are never logged or returned to the browser.
      return { headers: {}, query: { [auth.param]: fillTemplate(auth.value, context) } }

    case 'session-exchange':
      // Handled by the session manager after a login round trip; empty rather than throwing keeps
      // applyAuth total.
      return { headers: {}, query: {} }

    default: {
      const exhaustive: never = auth
      throw new Error(`unhandled auth kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])

/**
 * Redacts for logging by name and by credential-shaped substring, since a manifest names its own
 * header.
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
