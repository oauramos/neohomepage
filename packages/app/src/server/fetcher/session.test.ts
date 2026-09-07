import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { singleManifestSchema, type SingleManifest } from '@neohomepage/catalog-schema'
import { executeOperation } from './execute.ts'
import { SessionManager } from './session.ts'

/**
 * qBittorrent's shape: form login, session cookie, everything after it carries the cookie.
 * Pi-hole v6's shape is the other branch — a JSON body with the token at `session.sid`.
 */
const cookieManifest = (): SingleManifest =>
  singleManifestSchema.parse({
    manifestVersion: 1,
    id: 'qbittorrent-transfer',
    version: '1.0.0',
    displayName: 'qBittorrent',
    category: 'downloads',
    icon: 'qbittorrent',
    target: {
      fields: [
        { name: 'username', kind: 'string', label: 'Username', required: true },
        { name: 'password', kind: 'secret', label: 'Password', required: true },
      ],
      auth: {
        kind: 'session-exchange',
        loginPath: '/api/v2/auth/login',
        body: { username: '{{config:username}}', password: '{{secret:password}}' },
        sendAs: { kind: 'cookie' },
      },
    },
    config: [],
    operations: { info: { method: 'GET', path: '/api/v2/transfer/info', decode: 'json' } },
    projection: {
      op: 'pick',
      fields: {
        stats: {
          op: 'concat',
          of: [
            {
              op: 'pick',
              fields: {
                label: { op: 'const', value: 'Down' },
                value: { op: 'get', path: '$.dl_info_speed' },
              },
            },
          ],
        },
      },
    },
    presentation: { template: 'stat-grid' },
    poll: { defaultIntervalMs: 30_000, minIntervalMs: 10_000 },
    requires: {
      templates: ['stat-grid'],
      opcodes: ['concat', 'const', 'get', 'pick'],
      authKinds: ['session-exchange'],
      fetchKinds: ['json'],
    },
  })

const tokenManifest = (): SingleManifest => {
  const manifest = cookieManifest()
  return singleManifestSchema.parse({
    ...manifest,
    id: 'pihole-sessions',
    target: {
      ...manifest.target,
      auth: {
        kind: 'session-exchange',
        loginPath: '/api/auth',
        body: { password: '{{secret:password}}' },
        tokenPath: 'session.sid',
        sendAs: { kind: 'header', header: 'X-FTL-SID', value: '{{session}}' },
      },
    },
  })
}

let server: Server | null = null
afterEach(async () => {
  if (server !== null) {
    server.close()
    await once(server, 'close')
    server = null
  }
})

type Handler = Parameters<typeof createServer>[1]

async function listen(handler: Handler): Promise<string> {
  server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

const run = (
  manifest: SingleManifest,
  origin: string,
  pool: SessionManager,
  password = 'hunter2',
) =>
  executeOperation({
    manifest,
    operation: 'info',
    target: { origin, basePath: '', allowLoopback: true },
    config: {},
    auth: { secrets: { password }, config: { username: 'admin' } },
    now: '2026-09-06T12:00:00.000Z',
    sessions: pool,
  })

describe('the cookie flavour', () => {
  it('logs in once, then carries the cookie on the data request', async () => {
    const seen: { path: string; cookie?: string; body?: string }[] = []
    const origin = await listen((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += String(chunk)))
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
          body,
        })
        if (req.url === '/api/v2/auth/login') {
          res.writeHead(200, { 'set-cookie': 'SID=abc123; path=/; HttpOnly; SameSite=Strict' })
          res.end('Ok.')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"dl_info_speed":4096}')
      })
    })

    const pool = new SessionManager({ now: () => 1_000 })
    const result = await run(cookieManifest(), origin, pool)
    expect(result).toMatchObject({ ok: true })

    expect(seen.map((one) => one.path)).toEqual(['/api/v2/auth/login', '/api/v2/transfer/info'])
    expect(seen[0]?.body).toBe('username=admin&password=hunter2')
    // Attributes are browser instructions; echoing "path=/; HttpOnly" back would be malformed.
    expect(seen[1]?.cookie).toBe('SID=abc123')
  })

  it('shares one login between many requests on the same credential', async () => {
    // Six widgets on one qBittorrent must not open six sessions: it counts them and starts
    // refusing. This is the reason the manager exists at all rather than a per-request login.
    let logins = 0
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/api/v2/auth/login') {
          logins++
          res.writeHead(200, { 'set-cookie': 'SID=shared' })
          res.end('Ok.')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"dl_info_speed":1}')
      })
    })

    const pool = new SessionManager({ now: () => 1_000 })
    const manifest = cookieManifest()
    await Promise.all(Array.from({ length: 6 }, () => run(manifest, origin, pool)))
    expect(logins).toBe(1)
  })

  it('logs in again when the password changes', async () => {
    let logins = 0
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/api/v2/auth/login') {
          logins++
          res.writeHead(200, { 'set-cookie': `SID=${logins}` })
          res.end('Ok.')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"dl_info_speed":1}')
      })
    })

    const pool = new SessionManager({ now: () => 1_000 })
    const manifest = cookieManifest()
    await run(manifest, origin, pool, 'old-password')
    await run(manifest, origin, pool, 'new-password')
    expect(logins).toBe(2)
  })

  it('re-logs in exactly once, then lets the status stand', async () => {
    let logins = 0
    let dataRequests = 0
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/api/v2/auth/login') {
          logins++
          res.writeHead(200, { 'set-cookie': 'SID=stale' })
          res.end('Ok.')
          return
        }
        dataRequests++
        res.writeHead(403)
        res.end('Forbidden')
      })
    })

    const pool = new SessionManager({ now: () => 1_000 })
    // The status stands after one re-login: a FRESH session being refused means the credential
    // is wrong, and "http-403" says that where a synthetic "session-rejected" would hide it.
    // Two attempts and no more — services here ban an IP after N failures.
    expect(await run(cookieManifest(), origin, pool)).toMatchObject({ ok: false, code: 'http-403' })
    expect({ logins, dataRequests }).toEqual({ logins: 2, dataRequests: 2 })
  })

  it('reports a login that returns no cookie rather than sending an unauthenticated request', async () => {
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Fails.')
      })
    })
    const pool = new SessionManager({ now: () => 1_000 })
    expect(await run(cookieManifest(), origin, pool)).toMatchObject({
      ok: false,
      code: 'no-session-cookie',
    })
  })

  it('reports a refused login with its status', async () => {
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(403)
        res.end('Fails.')
      })
    })
    const pool = new SessionManager({ now: () => 1_000 })
    expect(await run(cookieManifest(), origin, pool)).toMatchObject({
      ok: false,
      code: 'login-http-403',
    })
  })
})

describe('the token flavour', () => {
  it('reads the token by path and sends it in the declared header', async () => {
    let seenHeader: string | undefined
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/api/auth') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"session":{"valid":true,"sid":"tok-42"}}')
          return
        }
        seenHeader = req.headers['x-ftl-sid'] as string
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"dl_info_speed":7}')
      })
    })

    const pool = new SessionManager({ now: () => 1_000 })
    expect(await run(tokenManifest(), origin, pool)).toMatchObject({ ok: true })
    expect(seenHeader).toBe('tok-42')
  })

  it('reports a login whose body has nothing at the declared path', async () => {
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"session":{"valid":false}}')
      })
    })
    const pool = new SessionManager({ now: () => 1_000 })
    expect(await run(tokenManifest(), origin, pool)).toMatchObject({
      ok: false,
      code: 'no-session-token',
    })
  })
})

describe('expiry and keys', () => {
  it('logs in again once the session has aged out', async () => {
    let logins = 0
    const origin = await listen((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/api/v2/auth/login') {
          logins++
          res.writeHead(200, { 'set-cookie': 'SID=x' })
          res.end('Ok.')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"dl_info_speed":1}')
      })
    })

    let clock = 0
    const pool = new SessionManager({ now: () => clock, ttlMs: 60_000 })
    const manifest = cookieManifest()
    await run(manifest, origin, pool)
    clock = 59_000
    await run(manifest, origin, pool)
    clock = 61_000
    await run(manifest, origin, pool)
    expect(logins).toBe(2)
  })

  it('keys on the credential, not only the target', () => {
    const auth = cookieManifest().target.auth as Extract<
      ReturnType<typeof cookieManifest>['target']['auth'],
      { kind: 'session-exchange' }
    >
    const one = SessionManager.key('http://nas:8080', '', auth, {
      secrets: { password: 'a' },
      config: {},
    })
    const two = SessionManager.key('http://nas:8080', '', auth, {
      secrets: { password: 'b' },
      config: {},
    })
    expect(one).not.toBe(two)
  })

  it('does not store the credential it keyed on', () => {
    const auth = cookieManifest().target.auth as Extract<
      ReturnType<typeof cookieManifest>['target']['auth'],
      { kind: 'session-exchange' }
    >
    const key = SessionManager.key('http://nas:8080', '', auth, {
      secrets: { password: 'hunter2' },
      config: {},
    })
    expect(key).not.toContain('hunter2')
    expect(key).toMatch(/^[a-f0-9]{32}$/)
  })
})
