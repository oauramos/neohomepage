import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import process from 'node:process'

/**
 * Open reads, authenticated writes. The session cookie is an HMAC over the expiry keyed from the
 * password, so sessions survive a restart and a password change revokes them all.
 */

/**
 * Content types a write may carry besides JSON. Must never include a type a cross-site <form> can
 * produce (urlencoded, multipart, text/plain); a test asserts this.
 */
export const UPLOADABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']

export type AuthMode = 'password' | 'forward' | 'none'

export type AuthConfig = {
  readonly mode: AuthMode
  readonly username: string
  readonly password: string
  /** CIDRs or exact addresses whose identity headers are believed, in forward-auth mode. */
  readonly trustedProxies: readonly string[]
  readonly sessionTtlMs: number
}

export const SESSION_COOKIE = 'neo_session'

export function readAuthConfig(): AuthConfig {
  const username = process.env.NEOHOMEPAGE_USERNAME ?? ''
  const password = process.env.NEOHOMEPAGE_PASSWORD ?? ''
  const declared = process.env.NEOHOMEPAGE_AUTH_MODE

  const mode: AuthMode =
    declared === 'forward' || declared === 'none'
      ? declared
      : username !== '' && password !== ''
        ? 'password'
        : 'none'

  return {
    mode,
    username,
    password,
    trustedProxies: (process.env.NEOHOMEPAGE_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  }
}

/** Refuses configurations that look secure and are not, e.g. forward-auth with no trusted proxies. */
export function assertAuthUsable(config: AuthConfig): void {
  if (config.mode === 'forward' && config.trustedProxies.length === 0) {
    throw new Error(
      'NEOHOMEPAGE_AUTH_MODE=forward requires NEOHOMEPAGE_TRUSTED_PROXIES: without it, any client ' +
        'that can reach this port can assert any identity',
    )
  }
  if (config.mode === 'password' && config.password.length < 8) {
    throw new Error('NEOHOMEPAGE_PASSWORD must be at least 8 characters')
  }
}

function sessionKey(config: AuthConfig): Buffer {
  // Derived from the password so a password change revokes every session, with no store to purge.
  return createHmac('sha256', 'neohomepage/session/v1').update(config.password).digest()
}

export function issueSession(config: AuthConfig, now: number): string {
  const expiresAt = now + config.sessionTtlMs
  const nonce = randomBytes(8).toString('hex')
  const payload = `${expiresAt}.${nonce}`
  const signature = createHmac('sha256', sessionKey(config)).update(payload).digest('hex')
  return `${payload}.${signature}`
}

export function verifySession(config: AuthConfig, token: string | undefined, now: number): boolean {
  if (token === undefined) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [expiresAt, nonce, signature] = parts as [string, string, string]

  const expected = createHmac('sha256', sessionKey(config))
    .update(`${expiresAt}.${nonce}`)
    .digest('hex')
  const provided = Buffer.from(signature, 'hex')
  const computed = Buffer.from(expected, 'hex')
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return false

  const deadline = Number(expiresAt)
  return Number.isFinite(deadline) && deadline > now
}

/** Constant-time credential check, so a wrong username is not distinguishable by timing. */
export function checkPassword(config: AuthConfig, username: string, password: string): boolean {
  const expectedUser = Buffer.from(config.username, 'utf8')
  const expectedPass = Buffer.from(config.password, 'utf8')
  const givenUser = Buffer.from(username, 'utf8')
  const givenPass = Buffer.from(password, 'utf8')

  const userOk =
    expectedUser.length === givenUser.length && timingSafeEqual(expectedUser, givenUser)
  const passOk =
    expectedPass.length === givenPass.length && timingSafeEqual(expectedPass, givenPass)
  return userOk && passOk
}

export type WriteCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 401 | 403; readonly reason: string }

export type RequestFacts = {
  readonly method: string
  readonly secFetchSite: string | undefined
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly contentType: string | undefined
  readonly cookie: string | undefined
  readonly forwardedUser: string | undefined
  readonly remoteAddress: string | undefined
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The CSRF checks run in every mode, including `none`: a page on the internet POSTing to a LAN
 * address does not care whether the target has a password.
 */
export function checkWrite(config: AuthConfig, request: RequestFacts, now: number): WriteCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { allowed: true }

  // Sec-Fetch-Site cannot be forged by page JavaScript. Absent means a non-browser client (curl,
  // an MCP bridge), which falls through to the credential check.
  if (request.secFetchSite !== undefined && request.secFetchSite !== 'same-origin') {
    return { allowed: false, status: 403, reason: 'cross-site writes are refused' }
  }

  // Fallback for the odd client that omits Sec-Fetch-Site but sends Origin.
  if (
    request.secFetchSite === undefined &&
    request.origin !== undefined &&
    request.host !== undefined
  ) {
    let originHost: string
    try {
      originHost = new URL(request.origin).host
    } catch {
      return { allowed: false, status: 403, reason: 'malformed Origin' }
    }
    if (originHost !== request.host) {
      return { allowed: false, status: 403, reason: 'cross-origin writes are refused' }
    }
  }

  // A cross-site <form> can only send urlencoded, multipart or text/plain, so requiring JSON (or
  // an image type, for the background upload) blocks it.
  const contentType = request.contentType ?? ''
  const allowed =
    contentType.startsWith('application/json') ||
    UPLOADABLE_TYPES.some((type) => contentType.startsWith(type))
  if (!allowed) {
    return { allowed: false, status: 403, reason: 'writes must be application/json' }
  }

  if (config.mode === 'none') return { allowed: true }

  if (config.mode === 'forward') {
    if (!isTrusted(config.trustedProxies, request.remoteAddress)) {
      return { allowed: false, status: 403, reason: 'request did not come from a trusted proxy' }
    }
    return request.forwardedUser === undefined || request.forwardedUser === ''
      ? { allowed: false, status: 401, reason: 'the proxy asserted no identity' }
      : { allowed: true }
  }

  const token = readCookie(request.cookie, SESSION_COOKIE)
  return verifySession(config, token, now)
    ? { allowed: true }
    : { allowed: false, status: 401, reason: 'sign in to make changes' }
}

/**
 * Only the socket address is consulted; a forwarded-for header would let anyone claim to be the
 * proxy.
 */
export function isTrusted(trusted: readonly string[], remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  const address = remoteAddress.replace(/^::ffff:/, '')
  return trusted.some((entry) => {
    const bare = entry.replace(/^::ffff:/, '')
    if (!bare.includes('/')) return bare === address
    return inCidr(address, bare)
  })
}

function inCidr(address: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  if (network === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const toInt = (value: string) => {
    const parts = value.split('.').map(Number)
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null
    }
    return parts.reduce((acc, part) => acc * 256 + part, 0)
  }

  const a = toInt(address)
  const n = toInt(network)
  if (a === null || n === null) return false
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
  return (a & mask) === (n & mask)
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

export function sessionCookie(token: string, ttlMs: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Strict, not Lax: Lax still sends the cookie on a top-level navigation someone else initiated.
    'SameSite=Strict',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ]
  // Secure on a plain-http LAN install would make the cookie silently never arrive.
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}
