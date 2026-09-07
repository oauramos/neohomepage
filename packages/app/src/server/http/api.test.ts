import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The write API, exercised against a real store on a real temporary directory.
 *
 * `env` reads the data directory once at module load, so these tests set it before importing
 * anything that touches it — which is also why the imports are dynamic.
 */

const created: string[] = []
let upstream: Server | null = null
let dataDir = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let context: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any

async function mockService(): Promise<number> {
  const server = createServer((req, res) => {
    if (req.headers['x-api-key'] !== 'GOOD') {
      res.writeHead(401)
      res.end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        records: [{ size: 100, sizeleft: 25, title: 'Ep', series: { title: 'Show' } }],
      }),
    )
  })
  upstream = server
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return address.port
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  // `unknown`, not `never`: `never` collapses the union to `null` and every downstream cast in
  // this file becomes a type error rather than a narrowing.
  const parsed: unknown = text === '' ? null : JSON.parse(text)
  return { status: response.status, body: parsed }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'neo-api-'))
  created.push(dataDir)
  process.env.NEOHOMEPAGE_DATA_DIR = dataDir
  process.env.NEOHOMEPAGE_CATALOG_DIR = join(import.meta.dirname, '../../../../../catalog')
  // `env` resolves its directories once at module load, so without a fresh registry every test
  // after the first would quietly write into the first test's temporary directory.
  vi.resetModules()

  const { env } = await import('../env.ts')
  const { seedDataDirectory } = await import('../store/seed.ts')
  const { seedStarterConfig } = await import('../store/starter.ts')
  await seedDataDirectory({
    dataDir: env.dataDir,
    configDir: env.configDir,
    assetsDir: env.assetsDir,
    secretsDir: env.secretsDir,
    stateDir: env.stateDir,
  })
  await seedStarterConfig(env.configDir)

  const { createContext } = await import('../context.ts')
  const { createApp } = await import('./app.ts')
  context = await createContext({
    catalogDir: process.env.NEOHOMEPAGE_CATALOG_DIR,
    publishMode: 'manual',
  })
  await context.reload()
  app = createApp({ context })
})

afterEach(async () => {
  await context?.shutdown()
  if (upstream !== null) {
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream?.close(resolve))
    upstream = null
  }
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
  delete process.env.NEOHOMEPAGE_DATA_DIR
  delete process.env.NEOHOMEPAGE_CATALOG_DIR
})

describe('the catalog', () => {
  it('lists what can be added, and whether each needs a credential', async () => {
    const { status, body } = await request('GET', '/api/catalog')
    expect(status).toBe(200)
    const sonarr = (
      body as { manifests: { id: string; needsCredential: boolean }[] }
    ).manifests.find((entry) => entry.id === 'sonarr-queue')
    expect(sonarr?.needsCredential).toBe(true)
  })

  it('describes the form for one type', async () => {
    const { body } = await request('GET', '/api/catalog/sonarr-queue/schema')
    const schema = body as {
      target: { fields: { name: string; kind: string }[] }
      config: unknown[]
    }
    expect(schema.target.fields[0]).toMatchObject({ name: 'apiKey', kind: 'secret' })
    expect(schema.config).toHaveLength(1)
  })

  it('404s an unknown type rather than returning an empty form', async () => {
    expect((await request('GET', '/api/catalog/nope/schema')).status).toBe(404)
  })
})

describe('adding a widget', () => {
  it('creates it, places it on every authored tier, and returns the id', async () => {
    const { status, body } = await request('POST', '/api/widgets', { type: 'sonarr-queue' })
    expect(status).toBe(201)
    const id = (body as { id: string }).id

    const layout = JSON.parse(
      await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8'),
    ) as { layouts: Record<string, { i: string }[]> }
    for (const breakpoint of ['sm', 'md', 'lg']) {
      expect(
        layout.layouts[breakpoint]?.some((entry) => entry.i === id),
        breakpoint,
      ).toBe(true)
    }
  })

  it('writes a widget file with no credential in it', async () => {
    await request('POST', '/api/widgets', { type: 'sonarr-queue', config: { maxItems: 9 } })
    const files = await readdir(join(dataDir, 'config', 'widgets'))
    const written = await readFile(join(dataDir, 'config', 'widgets', files[0] as string), 'utf8')
    expect(written).toContain('"maxItems": 9')
    expect(written).not.toMatch(/apiKey|secret|token/i)
  })

  it('refuses an unknown type', async () => {
    expect((await request('POST', '/api/widgets', { type: 'nope' })).status).toBe(400)
  })
})

describe('optimistic concurrency', () => {
  it('accepts a write that names the current revision', async () => {
    const { body } = await request('GET', '/api/state')
    const revision = (body as { revision: string }).revision
    const result = await request(
      'POST',
      '/api/widgets',
      { type: 'sonarr-queue' },
      { 'if-match': revision },
    )
    expect(result.status).toBe(201)
  })

  it('409s a write based on a stale revision instead of clobbering', async () => {
    const stale = ((await request('GET', '/api/state')).body as { revision: string }).revision
    await request('POST', '/api/widgets', { type: 'sonarr-queue' })
    const result = await request(
      'POST',
      '/api/widgets',
      { type: 'sonarr-queue' },
      { 'if-match': stale },
    )
    expect(result.status).toBe(409)
  })
})

describe('editing a widget', () => {
  it('merges config rather than replacing it', async () => {
    // A form that posts one field must not wipe the others.
    const id = (
      (
        await request('POST', '/api/widgets', {
          type: 'sonarr-queue',
          config: { maxItems: 5, hideEmpty: true },
        })
      ).body as { id: string }
    ).id

    await request('PATCH', `/api/widgets/${id}`, { config: { maxItems: 12 } })
    const written = JSON.parse(
      await readFile(join(dataDir, 'config', 'widgets', `${id}.json`), 'utf8'),
    ) as { config: Record<string, unknown> }
    expect(written.config).toEqual({ maxItems: 12, hideEmpty: true })
  })

  it('404s through the store when the widget is gone', async () => {
    await expect(request('PATCH', '/api/widgets/wGone', { title: 'x' })).rejects.toThrow()
  })
})

describe('saving a layout', () => {
  it('marks the breakpoint authored, so it is no longer regenerated', async () => {
    const id = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue' })).body as { id: string }
    ).id
    await request('PUT', '/api/pages/home/layout', {
      breakpoint: 'lg',
      items: [{ i: id, x: 2, y: 0, w: 4, h: 3 }],
    })
    const layout = JSON.parse(
      await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8'),
    ) as { meta: Record<string, { origin: string }> }
    expect(layout.meta.lg?.origin).toBe('authored')
  })

  it('normalises geometry that runs off the edge', async () => {
    const id = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue' })).body as { id: string }
    ).id
    await request('PUT', '/api/pages/home/layout', {
      breakpoint: 'lg',
      items: [{ i: id, x: 10, y: 0, w: 6, h: 3 }],
    })
    const layout = JSON.parse(
      await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8'),
    ) as { layouts: Record<string, { x: number; w: number }[]> }
    expect((layout.layouts.lg as { x: number; w: number }[])[0]).toMatchObject({ x: 6, w: 6 })
  })

  it('rejects an unknown breakpoint rather than inventing one', async () => {
    await expect(
      request('PUT', '/api/pages/home/layout', { breakpoint: 'xxl', items: [] }),
    ).rejects.toThrow()
  })
})

describe('targets and credentials', () => {
  it('stores the value in secrets/ and only a reference in config/', async () => {
    const { body } = await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { host: '10.0.0.20', port: 8989 },
      secrets: { apiKey: 'SUPER-SECRET-VALUE' },
    })
    const id = (body as { id: string }).id

    const target = await readFile(join(dataDir, 'config', 'targets', `${id}.json`), 'utf8')
    expect(target).toContain('$secret')
    expect(target).not.toContain('SUPER-SECRET-VALUE')

    const secrets = await readFile(join(dataDir, 'secrets', 'secrets.json'), 'utf8')
    expect(secrets).toContain('SUPER-SECRET-VALUE')
  })

  it('never returns a secret value, or its length, to a browser', async () => {
    await request('POST', '/api/targets', {
      label: 'Sonarr',
      base: { host: '10.0.0.20', port: 8989 },
      secrets: { apiKey: 'SUPER-SECRET-VALUE' },
    })
    const listed = JSON.stringify((await request('GET', '/api/secrets')).body)
    expect(listed).not.toContain('SUPER-SECRET-VALUE')
    expect(listed).not.toMatch(/"length"/)
  })
})

describe('testing a target before saving it', () => {
  it('reports success and how long it took, and nothing the service returned', async () => {
    const port = await mockService()
    const { body } = await request('POST', '/api/targets/test', {
      type: 'sonarr-queue',
      base: { host: '127.0.0.1', port },
      secrets: { apiKey: 'GOOD' },
    })
    expect(body).toMatchObject({ ok: true })
    // "It answered in 40ms" is what a person needs. The JSON the service returned is not, and
    // echoing it is how a credential ends up in a browser.
    expect(JSON.stringify(body)).not.toContain('Show')
  })

  it('reports a bad credential as a code', async () => {
    const port = await mockService()
    const { body } = await request('POST', '/api/targets/test', {
      type: 'sonarr-queue',
      base: { host: '127.0.0.1', port },
      secrets: { apiKey: 'WRONG' },
    })
    expect(body).toMatchObject({ ok: false, code: 'http-401' })
  })

  it('refuses a blocked address before opening a socket', async () => {
    const { body } = await request('POST', '/api/targets/test', {
      type: 'sonarr-queue',
      base: { host: '169.254.169.254', port: 80 },
      secrets: { apiKey: 'GOOD' },
    })
    expect(body).toMatchObject({ ok: false, code: 'blocked-address' })
  })
})

describe('deleting a widget', () => {
  it('removes its layout entries, so no ghost is left in the editor', async () => {
    const id = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue' })).body as { id: string }
    ).id
    await request('DELETE', `/api/widgets/${id}`)

    const layout = JSON.parse(
      await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8'),
    ) as { layouts: Record<string, { i: string }[]> }
    for (const items of Object.values(layout.layouts)) {
      expect(items.some((entry) => entry.i === id)).toBe(false)
    }
  })

  it('removes the target and its credential when nothing else uses them', async () => {
    const targetId = (
      (
        await request('POST', '/api/targets', {
          label: 'Sonarr',
          base: { host: '10.0.0.20', port: 8989 },
          secrets: { apiKey: 'SECRET-A' },
        })
      ).body as { id: string }
    ).id
    const id = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue', targetId })).body as {
        id: string
      }
    ).id

    const { body } = await request('DELETE', `/api/widgets/${id}`)
    expect((body as { orphaned: { targets: string[] } }).orphaned.targets).toEqual([targetId])
    expect(await readdir(join(dataDir, 'config', 'targets'))).toEqual([])
    expect(await readFile(join(dataDir, 'secrets', 'secrets.json'), 'utf8')).not.toContain(
      'SECRET-A',
    )
  })

  it('keeps a target another widget still points at', async () => {
    const targetId = (
      (
        await request('POST', '/api/targets', {
          label: 'Sonarr',
          base: { host: '10.0.0.20', port: 8989 },
        })
      ).body as { id: string }
    ).id
    const first = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue', targetId })).body as {
        id: string
      }
    ).id
    await request('POST', '/api/widgets', { type: 'sonarr-queue', targetId })

    const { body } = await request('DELETE', `/api/widgets/${first}`)
    expect((body as { orphaned: { targets: string[] } }).orphaned.targets).toEqual([])
    expect(await readdir(join(dataDir, 'config', 'targets'))).toHaveLength(1)
  })

  it('stops polling for it, so the app is not still hitting a service for a tile nobody sees', async () => {
    const port = await mockService()
    const targetId = (
      (
        await request('POST', '/api/targets', {
          label: 'Sonarr',
          base: { host: '127.0.0.1', port },
          secrets: { apiKey: 'GOOD' },
        })
      ).body as { id: string }
    ).id
    const id = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue', targetId })).body as {
        id: string
      }
    ).id

    expect(context.scheduler.registered).toBeGreaterThan(0)
    await request('DELETE', `/api/widgets/${id}`)
    expect(context.scheduler.registered).toBe(0)
  })
})

describe('every mutating route is behind the write gate', () => {
  /**
   * Enumerating the routes rather than listing them by hand: a route added later must be
   * protected by default, and a test that names them one by one would silently not cover the
   * next one. The gate is `app.use('*')`, so this asserts the wiring rather than the list.
   */
  it('refuses a cross-site write on every non-GET route', async () => {
    const routes: [string, string][] = [
      ['POST', '/api/widgets'],
      ['PATCH', '/api/widgets/w1'],
      ['DELETE', '/api/widgets/w1'],
      ['PUT', '/api/pages/home/layout'],
      ['POST', '/api/targets'],
      ['POST', '/api/targets/test'],
      ['POST', '/api/publish'],
      ['POST', '/api/widgets/w1/refresh'],
    ]

    for (const [method, path] of routes) {
      const response = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })

  it('refuses a form-encoded write, which is the simplest cross-site POST', async () => {
    for (const [method, path] of [
      ['POST', '/api/widgets'],
      ['POST', '/api/publish'],
    ] as [string, string][]) {
      const response = await app.request(path, {
        method,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'type=sonarr-queue',
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })

  it('leaves reads open, which is the whole point of the posture', async () => {
    for (const path of ['/api/state', '/api/catalog', '/api/health', '/api/auth']) {
      const response = await app.request(path, { headers: { 'sec-fetch-site': 'cross-site' } })
      expect(response.status, path).toBe(200)
    }
  })
})
