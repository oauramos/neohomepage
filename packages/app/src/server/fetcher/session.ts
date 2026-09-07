import { createHash } from 'node:crypto'
import type { Auth } from '@neohomepage/catalog-schema'
import { fillTemplate, MissingSecretError, type AppliedAuth, type AuthContext } from './auth.ts'
import { fetchUpstream, UpstreamError, type FetchLimits } from './client.ts'
import { assertUrlShape } from './policy.ts'

/**
 * The fifth auth kind: log in once, then carry what the login returned.
 *
 * Pi-hole v6 answers `POST /api/auth` with `session.sid`; qBittorrent answers
 * `POST /api/v2/auth/login` with a `Set-Cookie`. Neither can be expressed by attaching a static
 * header to every request, and pretending otherwise is why the kind existed in the schema with no
 * implementation behind it.
 *
 * Three properties this has to keep, all of which a naive version loses:
 *
 *   - The login request obeys the same rules as any other. Same SSRF policy, same origin-and-path
 *     assertion, same body cap. A login is an outbound request to a LAN address like any other,
 *     and giving it a private code path would give it a private set of holes.
 *   - One login per credential, shared. Six widgets on one qBittorrent must not each open a
 *     session; qBittorrent counts them and starts refusing.
 *   - A rejected session is discarded, not retried into a lockout. Services in this space ban an
 *     IP after N failures, so a loop that re-logs-in on every 403 turns a stale cookie into an
 *     hour of downtime.
 */

type SessionAuth = Extract<Auth, { kind: 'session-exchange' }>

type Session = {
  readonly applied: AppliedAuth
  readonly obtainedAt: number
}

export type SessionManagerDeps = {
  readonly now: () => number
  /** How long a session is reused before a fresh login. Services rarely publish their own TTL. */
  readonly ttlMs?: number
  readonly fetch?: typeof fetchUpstream
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
    this.#deps = { ttlMs: 30 * 60 * 1000, fetch: fetchUpstream, ...deps }
  }

  /**
   * The cache key.
   *
   * Includes the resolved credential, not just the target: rotating a password must not keep
   * serving the session the old one bought. The credential is hashed rather than stored so a heap
   * dump of this map is not a list of passwords.
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

  size(): number {
    return this.#sessions.size
  }

  invalidate(key: string): void {
    this.#sessions.delete(key)
  }

  clear(): void {
    this.#sessions.clear()
  }

  async authorize(input: {
    readonly auth: SessionAuth
    readonly origin: string
    readonly basePath: string
    readonly context: AuthContext
    readonly allowLoopback: boolean
    readonly insecureSkipVerify: boolean
    readonly limits?: Partial<FetchLimits>
  }): Promise<{ readonly key: string; readonly applied: AppliedAuth }> {
    const key = SessionManager.key(input.origin, input.basePath, input.auth, input.context)

    const existing = this.#sessions.get(key)
    if (existing !== undefined && this.#deps.now() - existing.obtainedAt < this.#deps.ttlMs) {
      return { key, applied: existing.applied }
    }

    // Collapse concurrent logins for the same credential into one. Without this, the scheduler
    // starting six widgets in the same tick sends six logins and half of them race to overwrite.
    let pending = this.#inFlight.get(key)
    if (pending === undefined) {
      pending = this.#login(input).finally(() => this.#inFlight.delete(key))
      this.#inFlight.set(key, pending)
    }
    const session = await pending
    this.#sessions.set(key, session)
    return { key, applied: session.applied }
  }

  async #login(input: {
    readonly auth: SessionAuth
    readonly origin: string
    readonly basePath: string
    readonly context: AuthContext
    readonly allowLoopback: boolean
    readonly insecureSkipVerify: boolean
    readonly limits?: Partial<FetchLimits>
  }): Promise<Session> {
    const { auth, context } = input

    const base = assertUrlShape(input.origin)
    const expectedPathname = `${input.basePath.replace(/\/+$/, '')}${auth.loginPath}`
    const url = new URL(expectedPathname, base)
    // The same assertion the operation executor makes. A login is not a special case.
    if (url.origin !== base.origin || url.pathname !== expectedPathname) {
      throw new SessionExchangeError('path-mismatch', 'the login URL is not the one declared')
    }

    const form = new URLSearchParams()
    for (const [field, template] of Object.entries(auth.body)) {
      form.set(field, fillTemplate(template, context))
    }

    let response
    try {
      response = await this.#deps.fetch({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        allowLoopback: input.allowLoopback,
        insecureSkipVerify: input.insecureSkipVerify,
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      })
    } catch (error) {
      if (error instanceof MissingSecretError || error instanceof UpstreamError) throw error
      throw new SessionExchangeError('login-unreachable', 'the login request did not complete')
    }

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
      // Name=value only. Attributes (Path, HttpOnly, SameSite) are instructions to a browser and
      // echoing them back as a request header is how a Cookie header ends up malformed.
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
 * Pull the token out of a JSON login response by dotted path.
 *
 * Deliberately not the projection DSL: this runs before any projection exists, on a body that is
 * a credential rather than data, and it must never be able to do anything but read one string.
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
