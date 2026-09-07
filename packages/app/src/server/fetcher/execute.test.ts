import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import {
  singleManifestSchema,
  type Operation,
  type SingleManifest,
} from '@neohomepage/catalog-schema'
import { buildOperationUrl, executeOperation, OperationError } from './execute.ts'

const servers: Server[] = []

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as Server
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

const MANIFEST: SingleManifest = singleManifestSchema.parse({
  manifestVersion: 1,
  id: 'demo',
  version: '1.0.0',
  displayName: 'Demo',
  category: 'media-automation',
  icon: 'demo',
  target: { fields: [], auth: { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' } },
  config: [{ name: 'maxItems', kind: 'integer', label: 'Items', default: 5 }],
  operations: {
    queue: { method: 'GET', path: '/api/v3/queue', query: { pageSize: '{{config:maxItems}}' } },
  },
  projection: {
    op: 'pick',
    fields: {
      stats: {
        op: 'concat',
        of: [
          {
            op: 'pick',
            fields: {
              label: { op: 'const', value: 'Queue' },
              value: { op: 'count', of: { op: 'get', path: '$.records' } },
            },
          },
        ],
      },
    },
  },
  presentation: { template: 'list' },
  poll: { defaultIntervalMs: 60000, minIntervalMs: 15000 },
  requires: {
    templates: ['list'],
    opcodes: ['concat', 'const', 'count', 'get', 'pick'],
    authKinds: ['header'],
    fetchKinds: ['json'],
  },
})

const target = (origin: string) => ({ origin, basePath: '', allowLoopback: true })
const auth = { secrets: { apiKey: 'KEY' }, config: {} }

describe('the central invariant: the caller never names a URL', () => {
  const operation = MANIFEST.operations.queue as Operation

  it('builds the URL from the manifest template and the bound target', () => {
    const url = buildOperationUrl(operation, target('http://10.0.0.20:8989'), { maxItems: 8 })
    expect(url.toString()).toBe('http://10.0.0.20:8989/api/v3/queue?pageSize=8')
  })

  it('treats a bare "/" as the target base path exactly', () => {
    // What lets an iCalendar feed keep its whole path in the target. Through a config hole the
    // value would be percent-encoded and /dav/cal.ics would become /dav%2Fcal.ics.
    const feed = { ...operation, path: '/', decode: 'ics' as const }
    expect(
      buildOperationUrl(
        feed,
        { ...target('http://nas.invalid:5232'), basePath: '/dav/cal.ics' },
        {},
      ).toString(),
    ).toBe('http://nas.invalid:5232/dav/cal.ics?pageSize=')
    expect(buildOperationUrl(feed, target('http://nas.invalid:5232'), {}).pathname).toBe('/')
  })

  it('applies the target base path', () => {
    const url = buildOperationUrl(
      operation,
      { ...target('http://10.0.0.20:8989'), basePath: '/sonarr' },
      {},
    )
    expect(url.pathname).toBe('/sonarr/api/v3/queue')
  })

  it('percent-encodes interpolated config, so a value cannot become path structure', () => {
    const traversal: Operation = { method: 'GET', path: '/api/{{config:name}}', decode: 'json' }
    const url = buildOperationUrl(traversal, target('http://10.0.0.20:8989'), {
      name: '../../admin',
    })
    // The value is encoded, so the path stays exactly one segment under /api.
    expect(url.pathname).toBe('/api/..%2F..%2Fadmin')
  })

  it('refuses a manifest that references a secret outside target.auth', () => {
    // A credential interpolated into a path or query lands in access logs, proxy logs and browser
    // history. The schema rejects this too; this is the runtime half of the same rule, so a
    // manifest that slipped past an older validator still cannot do it.
    const leaky: Operation = { method: 'GET', path: '/api/{{secret:apiKey}}', decode: 'json' }
    expect(() => buildOperationUrl(leaky, target('http://10.0.0.20:8989'), {})).toThrow(
      /may only be used in target\.auth/,
    )
    const leakyQuery: Operation = {
      method: 'GET',
      path: '/api',
      decode: 'json',
      query: { k: '{{secret:apiKey}}' },
    }
    expect(() => buildOperationUrl(leakyQuery, target('http://10.0.0.20:8989'), {})).toThrow(
      OperationError,
    )
  })

  it('never leaves the bound origin', () => {
    const escape: Operation = { method: 'GET', path: '/{{config:p}}', decode: 'json' }
    for (const p of ['/evil.example.com/x', '\\evil.example.com', '@evil.example.com']) {
      const url = buildOperationUrl(escape, target('http://10.0.0.20:8989'), { p })
      expect(url.origin).toBe('http://10.0.0.20:8989')
    }
  })
})

describe('executing an operation end to end', () => {
  it('fetches, decodes and projects', async () => {
    let seenPath: string | undefined
    let seenKey: string | undefined
    const origin = await serve((req, res) => {
      seenPath = req.url
      seenKey = req.headers['x-api-key'] as string
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"records":[{"id":1},{"id":2}]}')
    })

    const result = await executeOperation({
      manifest: MANIFEST,
      operation: 'queue',
      target: target(origin),
      config: { maxItems: 3 },
      auth,
      now: '2026-09-06T12:00:00.000Z',
    })

    expect(seenPath).toBe('/api/v3/queue?pageSize=3')
    expect(seenKey).toBe('KEY')
    expect(result).toEqual({
      ok: true,
      status: 200,
      projection: { stats: [{ label: 'Queue', value: 2 }] },
    })
  })

  it('reports a missing credential as a code, not as a crash', async () => {
    const origin = await serve((_req, res) => res.end('{}'))
    const result = await executeOperation({
      manifest: MANIFEST,
      operation: 'queue',
      target: target(origin),
      config: {},
      auth: { secrets: {}, config: {} },
      now: '2026-09-06T12:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'missing-credential' })
  })

  it('turns a 401 into a code a widget can render', async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(401)
      res.end('bad key')
    })
    const result = await executeOperation({
      manifest: MANIFEST,
      operation: 'queue',
      target: target(origin),
      config: {},
      auth,
      now: '2026-09-06T12:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'http-401' })
    // The upstream body never travels with the error.
    expect(JSON.stringify(result)).not.toContain('bad key')
  })

  it('reports malformed JSON without echoing what the target sent', async () => {
    const origin = await serve((_req, res) => res.end('<html>login page with ?token=abc123</html>'))
    const result = await executeOperation({
      manifest: MANIFEST,
      operation: 'queue',
      target: target(origin),
      config: {},
      auth,
      now: '2026-09-06T12:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'bad-json' })
    expect(JSON.stringify(result)).not.toContain('abc123')
  })

  it('refuses a blocked address before opening a socket', async () => {
    const result = await executeOperation({
      manifest: MANIFEST,
      operation: 'queue',
      target: { origin: 'http://169.254.169.254', basePath: '' },
      config: {},
      auth,
      now: '2026-09-06T12:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'blocked-address' })
  })

  it('reports an unknown operation rather than guessing', async () => {
    const result = await executeOperation({
      manifest: MANIFEST,
      operation: 'nope',
      target: target('http://10.0.0.20:8989'),
      config: {},
      auth,
      now: '2026-09-06T12:00:00.000Z',
    })
    expect(result).toMatchObject({ ok: false, code: 'unknown-operation' })
  })
})
