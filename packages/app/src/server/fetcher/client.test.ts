import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { fetchUpstream, UpstreamError } from './client.ts'

/**
 * These run against a real loopback HTTP server rather than a mocked dispatcher: the behaviours
 * that matter — a body abort mid-stream, a redirect not being followed, a timeout — are all
 * properties of the socket layer, and a mock would only test the mock.
 *
 * `allowLoopback` is set throughout, because loopback is blocked by default and that is the
 * policy module's job to enforce, not this one's.
 */

const servers: Server[] = []

async function serve(handler: Parameters<typeof createServer>[1]): Promise<URL> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return new URL(`http://127.0.0.1:${address.port}/`)
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as Server
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

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
    // One misconfigured target returning a 500 MB body is otherwise an instant OOM on a 1 GB box.
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
    // Following a redirect reopens the whole validate-then-redirect bypass class — the exact bug
    // that broke gethomepage's first SSRF fix within hours of shipping.
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
    // The message reaches the browser. A dashboard has leaked API keys through verbose errors
    // before, so upstream detail never travels with it.
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
    // Close the server, then dial the port nothing is listening on any more.
    const server = servers.pop() as Server
    await new Promise((resolve) => server.close(resolve))

    const error = (await fetchUpstream({ url: dead, method: 'GET', allowLoopback: true }).catch(
      (e) => e,
    )) as UpstreamError
    expect(['refused', 'unreachable']).toContain(error.code)
    expect(error.message).not.toContain(dead.port)
  })
})

describe('the policy still applies', () => {
  it('refuses loopback when the target has not been declared local', async () => {
    const url = await serve((_req, res) => res.end('{}'))
    await expect(fetchUpstream({ url, method: 'GET' })).rejects.toThrow(/refusing to connect/)
  })
})
