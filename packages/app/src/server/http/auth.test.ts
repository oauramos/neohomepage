import { describe, expect, it } from 'vitest'
import {
  assertAuthUsable,
  checkPassword,
  checkWrite,
  isTrusted,
  issueSession,
  readCookie,
  sessionCookie,
  verifySession,
  type AuthConfig,
  type RequestFacts,
} from './auth.ts'

const NOW = 1_800_000_000_000

const config = (overrides: Partial<AuthConfig> = {}): AuthConfig => ({
  mode: 'password',
  username: 'neo',
  password: 'correct-horse',
  trustedProxies: [],
  sessionTtlMs: 60_000,
  ...overrides,
})

const facts = (overrides: Partial<RequestFacts> = {}): RequestFacts => ({
  method: 'POST',
  secFetchSite: 'same-origin',
  origin: undefined,
  host: 'nas.local:7575',
  contentType: 'application/json',
  cookie: undefined,
  forwardedUser: undefined,
  remoteAddress: '10.0.0.5',
  ...overrides,
})

describe('startup checks', () => {
  it('refuses forward-auth with no trusted proxies', () => {
    // Believing an identity header from anyone who can reach the port is strictly worse than no
    // auth, because it looks like auth.
    expect(() => assertAuthUsable(config({ mode: 'forward' }))).toThrow(/TRUSTED_PROXIES/)
    expect(() =>
      assertAuthUsable(config({ mode: 'forward', trustedProxies: ['10.0.0.1'] })),
    ).not.toThrow()
  })

  it('refuses a trivially short password', () => {
    expect(() => assertAuthUsable(config({ password: 'abc' }))).toThrow(/at least 8/)
  })

  it('allows the open mode without complaint', () => {
    expect(() =>
      assertAuthUsable(config({ mode: 'none', username: '', password: '' })),
    ).not.toThrow()
  })
})

describe('sessions', () => {
  it('round-trips a freshly issued token', () => {
    const auth = config()
    expect(verifySession(auth, issueSession(auth, NOW), NOW + 1000)).toBe(true)
  })

  it('rejects an expired token', () => {
    const auth = config()
    expect(verifySession(auth, issueSession(auth, NOW), NOW + 60_001)).toBe(false)
  })

  it('rejects a tampered expiry', () => {
    const auth = config()
    const token = issueSession(auth, NOW)
    const [, nonce, signature] = token.split('.')
    expect(verifySession(auth, `${NOW + 999_999_999}.${nonce}.${signature}`, NOW)).toBe(false)
  })

  it('invalidates every session when the password changes', () => {
    // The key is derived from the password, so a rotation revokes outstanding sessions with no
    // store to purge — which is the behaviour someone changing a leaked password expects.
    const before = config()
    const token = issueSession(before, NOW)
    expect(verifySession(before, token, NOW)).toBe(true)
    expect(verifySession(config({ password: 'a-new-password' }), token, NOW)).toBe(false)
  })

  it('rejects malformed tokens rather than throwing', () => {
    const auth = config()
    for (const token of ['', 'x', 'a.b', 'a.b.c.d', '1.2.zz']) {
      expect(() => verifySession(auth, token, NOW)).not.toThrow()
      expect(verifySession(auth, token, NOW)).toBe(false)
    }
  })
})

describe('credentials', () => {
  it('accepts the configured pair and nothing else', () => {
    const auth = config()
    expect(checkPassword(auth, 'neo', 'correct-horse')).toBe(true)
    expect(checkPassword(auth, 'neo', 'wrong')).toBe(false)
    expect(checkPassword(auth, 'someone', 'correct-horse')).toBe(false)
    expect(checkPassword(auth, '', '')).toBe(false)
  })

  it('does not throw on a length mismatch', () => {
    // timingSafeEqual throws when the buffers differ in length; guarding first is what keeps a
    // wrong-length password a `false` rather than a 500.
    expect(() => checkPassword(config(), 'n', 'x')).not.toThrow()
  })
})

describe('what may write', () => {
  it('lets reads through in every mode', () => {
    for (const mode of ['password', 'forward', 'none'] as const) {
      const auth = config({ mode, trustedProxies: ['10.0.0.0/8'] })
      expect(checkWrite(auth, facts({ method: 'GET' }), NOW).allowed, mode).toBe(true)
    }
  })

  it('refuses a cross-site write even with no auth configured', () => {
    // The attack is a page on the internet POSTing to a LAN address. It does not care whether the
    // target has a password, so this defence stays on in every mode.
    const open = config({ mode: 'none' })
    const decision = checkWrite(open, facts({ secFetchSite: 'cross-site' }), NOW)
    expect(decision).toMatchObject({ allowed: false, status: 403 })
  })

  it('refuses a form-encoded write, which is the simplest cross-site POST there is', () => {
    const open = config({ mode: 'none' })
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']) {
      expect(
        checkWrite(open, facts({ contentType: type, secFetchSite: undefined }), NOW),
      ).toMatchObject({
        allowed: false,
      })
    }
  })

  it('falls back to Origin when Sec-Fetch-Site is absent', () => {
    const open = config({ mode: 'none' })
    expect(
      checkWrite(open, facts({ secFetchSite: undefined, origin: 'http://evil.example.com' }), NOW),
    ).toMatchObject({ allowed: false, status: 403 })
    expect(
      checkWrite(open, facts({ secFetchSite: undefined, origin: 'http://nas.local:7575' }), NOW),
    ).toMatchObject({ allowed: true })
  })

  it('allows a non-browser client that sends neither header, subject to credentials', () => {
    // curl and the MCP bridge send no Sec-Fetch-Site. Blocking them outright would break the
    // command line; they still have to satisfy the credential check.
    const open = config({ mode: 'none' })
    expect(checkWrite(open, facts({ secFetchSite: undefined }), NOW)).toMatchObject({
      allowed: true,
    })

    const guarded = config()
    expect(checkWrite(guarded, facts({ secFetchSite: undefined }), NOW)).toMatchObject({
      allowed: false,
      status: 401,
    })
  })

  it('requires a valid session in password mode', () => {
    const auth = config()
    expect(checkWrite(auth, facts(), NOW)).toMatchObject({ allowed: false, status: 401 })

    const token = issueSession(auth, NOW)
    expect(checkWrite(auth, facts({ cookie: `neo_session=${token}` }), NOW)).toMatchObject({
      allowed: true,
    })
  })
})

describe('forward auth', () => {
  const auth = config({ mode: 'forward', trustedProxies: ['10.0.0.1', '192.168.1.0/24'] })

  it('accepts an identity from a trusted peer', () => {
    expect(
      checkWrite(auth, facts({ remoteAddress: '10.0.0.1', forwardedUser: 'otavio' }), NOW),
    ).toMatchObject({ allowed: true })
  })

  it('refuses the same identity from an untrusted peer', () => {
    // Otherwise anyone who can reach the port simply sends the header themselves.
    expect(
      checkWrite(auth, facts({ remoteAddress: '10.9.9.9', forwardedUser: 'otavio' }), NOW),
    ).toMatchObject({ allowed: false, status: 403 })
  })

  it('refuses a trusted peer that asserted nobody', () => {
    expect(checkWrite(auth, facts({ remoteAddress: '10.0.0.1' }), NOW)).toMatchObject({
      allowed: false,
      status: 401,
    })
  })
})

describe('trusted peers', () => {
  it('matches exact addresses and CIDRs', () => {
    expect(isTrusted(['10.0.0.1'], '10.0.0.1')).toBe(true)
    expect(isTrusted(['10.0.0.1'], '10.0.0.2')).toBe(false)
    expect(isTrusted(['192.168.1.0/24'], '192.168.1.55')).toBe(true)
    expect(isTrusted(['192.168.1.0/24'], '192.168.2.55')).toBe(false)
  })

  it('sees through the IPv4-mapped IPv6 form', () => {
    // Node reports a dual-stack peer as ::ffff:10.0.0.1, and a naive string compare against the
    // configured 10.0.0.1 would silently never match.
    expect(isTrusted(['10.0.0.1'], '::ffff:10.0.0.1')).toBe(true)
    expect(isTrusted(['192.168.1.0/24'], '::ffff:192.168.1.9')).toBe(true)
  })

  it('trusts nobody when the list is empty or the peer is unknown', () => {
    expect(isTrusted([], '10.0.0.1')).toBe(false)
    expect(isTrusted(['10.0.0.1'], undefined)).toBe(false)
  })
})

describe('the cookie', () => {
  it('is HttpOnly and SameSite=Strict', () => {
    const cookie = sessionCookie('token', 60_000, false)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('only sets Secure over https', () => {
    // On a plain-http LAN install, Secure would make the cookie silently never arrive, which
    // presents as "signing in does nothing".
    expect(sessionCookie('token', 60_000, false)).not.toContain('Secure')
    expect(sessionCookie('token', 60_000, true)).toContain('Secure')
  })

  it('parses a value out of a header with several cookies', () => {
    expect(readCookie('a=1; neo_session=abc.def; b=2', 'neo_session')).toBe('abc.def')
    expect(readCookie('a=1', 'neo_session')).toBeUndefined()
    expect(readCookie(undefined, 'neo_session')).toBeUndefined()
  })
})
