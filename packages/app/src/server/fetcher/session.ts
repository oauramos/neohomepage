import { createHash } from 'node:crypto'
import type { Auth } from '@neohomepage/catalog-schema'
import { fillTemplate, type AppliedAuth, type AuthContext } from './auth.ts'
import { fetchUpstream } from './client.ts'
import { assertUrlShape } from './policy.ts'

/**
 * Session-exchange auth: log in once, then carry what the login returned (Pi-hole v6 answers with
 * a JSON token at `session.sid`, qBittorrent with a `Set-Cookie`).
 */

type SessionAuth = Extract<Auth, { kind: 'session-exchange' }>

type Session = {
  readonly applied: AppliedAuth
  readonly obtainedAt: number
}

type AuthorizeInput = {
  readonly auth: SessionAuth
  readonly origin: string
  readonly basePath: string
  readonly context: AuthContext
  readonly allowLoopback: boolean
  readonly insecureSkipVerify: boolean
}

export type SessionManagerDeps = {
  readonly now: () => number
  /** Reuse window before a fresh login; services rarely publish their own TTL. */
  readonly ttlMs?: number
}

export class SessionExchangeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SessionExchangeError'
    this.code = code
  }
}

export class SessionManager {
  #sessions = new Map<string, Session>()
  #inFlight = new Map<string, Promise<Session>>()
  readonly #deps: Required<SessionManagerDeps>

  constructor(deps: SessionManagerDeps) {
    this.#deps = { ttlMs: 30 * 60 * 1000, ...deps }
  }

  /**
   * Cache key. Includes the credential so a rotated password does not keep serving the old
   * session; hashed so a heap dump of the map is not a list of passwords.
   */
  static key(origin: string, basePath: string, auth: SessionAuth, context: AuthContext): string {
    const material = JSON.stringify({
      origin,
      basePath,
      loginPath: auth.loginPath,
      body: Object.entries(auth.body).sort(),
      secrets: Object.entries(context.secrets).sort(),
      config: Object.entries(context.config).sort(),
    })
    return createHash('sha256').update(material).digest('hex').slice(0, 32)
  }

  invalidate(key: string): void {
    this.#sessions.delete(key)
  }

  async authorize(
    input: AuthorizeInput,
  ): Promise<{ readonly key: string; readonly applied: AppliedAuth }> {
    const key = SessionManager.key(input.origin, input.basePath, input.auth, input.context)

    const existing = this.#sessions.get(key)
    if (existing !== undefined && this.#deps.now() - existing.obtainedAt < this.#deps.ttlMs) {
      return { key, applied: existing.applied }
    }

    // Collapses concurrent logins for one credential; qBittorrent counts sessions and refuses.
    let pending = this.#inFlight.get(key)
    if (pending === undefined) {
      pending = this.#login(input).finally(() => this.#inFlight.delete(key))
      this.#inFlight.set(key, pending)
    }
    const session = await pending
    this.#sessions.set(key, session)
    return { key, applied: session.applied }
  }

  async #login(input: AuthorizeInput): Promise<Session> {
    const { auth, context } = input

    const base = assertUrlShape(input.origin)
    const expectedPathname = `${input.basePath.replace(/\/+$/, '')}${auth.loginPath}`
    const url = new URL(expectedPathname, base)
    // Same origin-and-path assertion the operation executor makes; a login is not a special case.
    if (url.origin !== base.origin || url.pathname !== expectedPathname) {
      throw new SessionExchangeError('path-mismatch', 'the login URL is not the one declared')
    }

    const form = new URLSearchParams()
    for (const [field, template] of Object.entries(auth.body)) {
      form.set(field, fillTemplate(template, context))
    }

    const response = await fetchUpstream({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      allowLoopback: input.allowLoopback,
      insecureSkipVerify: input.insecureSkipVerify,
    })

    if (response.status >= 400) {
      throw new SessionExchangeError(
        `login-http-${response.status}`,
        `the target refused the login with ${response.status}`,
      )
    }

    return { applied: this.#extract(auth, response), obtainedAt: this.#deps.now() }
  }

  #extract(
    auth: SessionAuth,
    response: { readonly headers: Readonly<Record<string, string>>; readonly body: string },
  ): AppliedAuth {
    if (auth.sendAs.kind === 'cookie') {
      const setCookie = response.headers['set-cookie']
      if (setCookie === undefined || setCookie === '') {
        throw new SessionExchangeError('no-session-cookie', 'the login returned no session cookie')
      }
      // Name=value only: attributes (Path, HttpOnly, SameSite) are browser instructions and
      // malform a Cookie header when echoed back.
      const pairs = setCookie
        .split(/,(?=[^;]+?=)/)
        .map((one) => one.split(';', 1)[0]?.trim())
        .filter((one): one is string => one !== undefined && one.includes('='))
      if (pairs.length === 0) {
        throw new SessionExchangeError('no-session-cookie', 'the login returned no session cookie')
      }
      return { headers: { cookie: pairs.join('; ') }, query: {} }
    }

    const token = readTokenPath(response.body, auth.tokenPath)
    if (token === null) {
      throw new SessionExchangeError(
        'no-session-token',
        auth.tokenPath === undefined
          ? 'the login returned no token and the manifest names no path to one'
          : `the login response has no value at "${auth.tokenPath}"`,
      )
    }
    return {
      headers: { [auth.sendAs.header]: auth.sendAs.value.replaceAll('{{session}}', token) },
      query: {},
    }
  }
}

/**
 * Reads the token out of a JSON login response by dotted path. Deliberately not the projection
 * DSL: the body is a credential, and this must never do more than read one string.
 */
function readTokenPath(body: string, path: string | undefined): string | null {
  if (path === undefined) return null
  let cursor: unknown
  try {
    cursor = JSON.parse(body)
  } catch {
    return null
  }
  for (const step of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[step]
  }
  return typeof cursor === 'string' && cursor !== '' ? cursor : null
}
