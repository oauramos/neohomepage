import { afterEach, describe, expect, it } from 'vitest'
import { fetchUpstream, UpstreamError } from './client.ts'
import { closeLatest, closeServers, serve } from './fixtures.ts'

// Runs against a real loopback server. `allowLoopback` is set throughout because loopback is
// blocked by default; the policy module's tests cover that.

afterEach(closeServers)

describe('ordinary requests', () => {
  it('returns status, headers and body', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const response = await fetchUpstream({ url, method: 'GET', allowLoopback: true })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/json')
    expect(response.body).toBe('{"ok":true}')
    expect(response.truncated).toBe(false)
  })

  it('sends the headers it was given', async () => {
    let seen: string | undefined
    const url = await serve((req, res) => {
      seen = req.headers['x-api-key'] as string
      res.end('{}')
    })
    await fetchUpstream({ url, method: 'GET', headers: { 'x-api-key': 'k' }, allowLoopback: true })
    expect(seen).toBe('k')
  })

  it('returns a non-2xx status rather than throwing, so a widget can show it', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(401)
      res.end('nope')
    })
    const response = await fetchUpstream({ url, method: 'GET', allowLoopback: true })
    expect(response.status).toBe(401)
  })
})

describe('the body cap', () => {
  it('aborts a huge response at the limit instead of buffering it', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200)
      const chunk = 'x'.repeat(64 * 1024)
      const pump = () => {
        while (res.write(chunk)) {
          // Keep writing until the socket applies backpressure or the client goes away.
        }
      }
      res.on('drain', pump)
      pump()
    })
    const response = await fetchUpstream({
      url,
      method: 'GET',
      allowLoopback: true,
      limits: { maxBodyBytes: 128 * 1024 },
    })
    expect(response.truncated).toBe(true)
    expect(response.body.length).toBe(128 * 1024)
  })

  it('does not mark an exactly-at-the-limit body as truncated', async () => {
    const url = await serve((_req, res) => res.end('y'.repeat(1000)))
    const response = await fetchUpstream({
      url,
      method: 'GET',
      allowLoopback: true,
      limits: { maxBodyBytes: 1000 },
    })
    expect(response.truncated).toBe(false)
    expect(response.body.length).toBe(1000)
  })
})

describe('redirects', () => {
  it('refuses to follow one, and says what to do instead', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    })
    const error = await fetchUpstream({ url, method: 'GET', allowLoopback: true }).catch((e) => e)
    expect(error).toBeInstanceOf(UpstreamError)
    expect((error as UpstreamError).code).toBe('redirect')
    expect((error as UpstreamError).message).toMatch(/update the saved URL/)
  })

  it('does not leak the redirect destination into the message', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(301, { location: 'http://secret-host.internal/?token=abc123' })
      res.end()
    })
    const error = (await fetchUpstream({ url, method: 'GET', allowLoopback: true }).catch(
      (e) => e,
    )) as Error
    expect(error.message).not.toContain('abc123')
    expect(error.message).not.toContain('secret-host')
  })
})

describe('failures carry a code, not a URL', () => {
  it('reports a timeout', async () => {
    const url = await serve(() => {
      // Never respond.
    })
    const error = (await fetchUpstream({
      url,
      method: 'GET',
      allowLoopback: true,
      limits: { headersTimeoutMs: 150, totalTimeoutMs: 300 },
    }).catch((e) => e)) as UpstreamError
    expect(error.code).toBe('timeout')
  })

  it('reports a refused connection without echoing the address', async () => {
    const url = await serve((_req, res) => res.end('{}'))
    const dead = new URL(url.toString())
    await closeLatest()

    const error = (await fetchUpstream({ url: dead, method: 'GET', allowLoopback: true }).catch(
      (e) => e,
    )) as UpstreamError
    expect(['refused', 'unreachable']).toContain(error.code)
    expect(error.message).not.toContain(dead.port)
  })

  it('reaches the socket for an https target named by IP literal', async () => {
    // Node rejects an IP literal as TLS servername before dialing, so the dial must get as far as
    // the closed port and be refused by it.
    const url = await serve((_req, res) => res.end('{}'))
    await closeLatest()
    const dead = new URL(`https://127.0.0.1:${url.port}/`)

    const error = (await fetchUpstream({
      url: dead,
      method: 'GET',
      allowLoopback: true,
      insecureSkipVerify: true,
    }).catch((e) => e)) as UpstreamError
    expect(error.code).toBe('refused')
    expect((error.cause as { code?: string }).code).not.toBe('ERR_INVALID_ARG_VALUE')
  })
})

describe('the policy still applies', () => {
  it('refuses loopback when the target has not been declared local', async () => {
    const url = await serve((_req, res) => res.end('{}'))
    await expect(fetchUpstream({ url, method: 'GET' })).rejects.toThrow(/refusing to connect/)
  })
})
