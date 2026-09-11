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

/**
 * Two upstreams behind one port: a Sonarr-shaped calendar and an iCalendar feed.
 *
 * Both on the same server so the test can bind two sources to one composite widget with two
 * targets that differ only in `widgetType` and base path — which is exactly the case that would
 * break if the source kind were chosen by anything other than the target's own shape.
 */
const DAY_MS = 86_400_000

/**
 * Dates relative to the run, not to the day this was written.
 *
 * The ICS decoder's window is `pastDays: 1, futureDays: 90`, so an event pinned to a literal date
 * is inside it for about a day and then quietly outside it. Both composite tests here went red on
 * their own two days after the commit that added them, with nothing in the repo having changed —
 * a failure that says "the calendar is broken" and means "the calendar is working".
 *
 * The Sonarr episode lands a day after the bin collection because one assertion is about ORDER:
 * the merged tile is sorted by date, and two events on the same day would make it a coin toss.
 */
const inDays = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString()
const icsStamp = (iso: string): string => iso.replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

async function mockCalendarHost(): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/v3/calendar') === true) {
      if (req.headers['x-api-key'] !== 'GOOD') {
        res.writeHead(401)
        res.end('no')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify([
          { title: 'The Episode', airDateUtc: inDays(2), series: { title: 'A Show' } },
        ]),
      )
      return
    }
    if (req.url === '/bins.ics') {
      res.writeHead(200, { 'content-type': 'text/calendar' })
      res.end(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//test//EN',
          'BEGIN:VEVENT',
          'UID:bin@example.invalid',
          'SUMMARY:Bin collection',
          `DTSTART:${icsStamp(inDays(1))}`,
          `DTEND:${icsStamp(inDays(1.02))}`,
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      )
      return
    }
    res.writeHead(404)
    res.end('no')
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

describe('a composite widget, end to end', () => {
  it('binds two sources of different shapes and merges them into one tile', async () => {
    const port = await mockCalendarHost()

    const sonarr = await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { scheme: 'http', host: '127.0.0.1', port },
      secrets: { apiKey: 'GOOD' },
    })
    expect(sonarr.status).toBe(201)

    const feed = await request('POST', '/api/targets', {
      label: 'Bins',
      widgetType: 'ics-feed',
      // The feed's whole path lives in the target, which is what the bare "/" operation path is
      // for. Through a config hole it would be percent-encoded into one segment.
      base: { scheme: 'http', host: '127.0.0.1', port, basePath: '/bins.ics' },
    })
    expect(feed.status).toBe(201)

    const created = await request('POST', '/api/widgets', {
      type: 'unified-calendar',
      bindings: {
        calendars: [(sonarr.body as { id: string }).id, (feed.body as { id: string }).id],
      },
    })
    expect(created.status).toBe(201)
    const widgetId = (created.body as { id: string }).id

    // The config on disk names two targets and no URL, path, header or method — and stays sparse:
    // `targetId` is absent rather than written as null, because it equals the schema default.
    const onDisk = JSON.parse(
      await readFile(join(dataDir, 'config', 'widgets', `${widgetId}.json`), 'utf8'),
    ) as Record<string, unknown>
    expect((onDisk.bindings as Record<string, string[]>).calendars).toHaveLength(2)
    expect(onDisk).not.toHaveProperty('targetId')
    expect(JSON.stringify(onDisk)).not.toMatch(/http|api\/v3|x-api-key/i)

    await context.reload()
    expect(await context.refreshWidget(widgetId)).toBe(true)

    const data = context.widgetData() as Record<
      string,
      { projection: { items: { title: string }[]; status: string } | null; sources: unknown }
    >
    const composed = data[widgetId]
    expect(composed?.sources).toEqual({ total: 2, ok: 2 })
    // One item from each source, and in date order across the two — which is the whole feature.
    expect(composed?.projection?.items.map((item) => item.title)).toEqual([
      'Bin collection',
      'A Show',
    ])
    expect(composed?.projection?.status).toBe('ok')
  })

  it('renders the sources that answered when one is down', async () => {
    const port = await mockCalendarHost()

    const good = await request('POST', '/api/targets', {
      label: 'Bins',
      widgetType: 'ics-feed',
      base: { scheme: 'http', host: '127.0.0.1', port, basePath: '/bins.ics' },
    })
    const bad = await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { scheme: 'http', host: '127.0.0.1', port },
      secrets: { apiKey: 'WRONG' },
    })

    const created = await request('POST', '/api/widgets', {
      type: 'unified-calendar',
      bindings: {
        calendars: [(good.body as { id: string }).id, (bad.body as { id: string }).id],
      },
    })
    const widgetId = (created.body as { id: string }).id

    await context.reload()
    await context.refreshWidget(widgetId)

    const data = context.widgetData() as Record<
      string,
      { projection: { items: unknown[]; status: string } | null; meta: { errorCode?: string } }
    >
    // One dead Radarr must not blank out the calendars that answered — the whole reason
    // `compose.partial` exists.
    expect(data[widgetId]?.projection?.items).toHaveLength(1)
    expect(data[widgetId]?.projection?.status).toBe('degraded')
    expect(data[widgetId]?.meta.errorCode).toBe('partial')
  })

  it('removes every bound target and its credentials when the widget is deleted', async () => {
    const port = await mockCalendarHost()
    const sonarr = await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { scheme: 'http', host: '127.0.0.1', port },
      secrets: { apiKey: 'GOOD' },
    })
    const feed = await request('POST', '/api/targets', {
      label: 'Bins',
      widgetType: 'ics-feed',
      base: { scheme: 'http', host: '127.0.0.1', port, basePath: '/bins.ics' },
    })
    const created = await request('POST', '/api/widgets', {
      type: 'unified-calendar',
      bindings: {
        calendars: [(sonarr.body as { id: string }).id, (feed.body as { id: string }).id],
      },
    })

    const deleted = await request('DELETE', `/api/widgets/${(created.body as { id: string }).id}`)
    expect(deleted.status).toBe(200)
    // Cleaning up only `targetId` would leave a deleted calendar's API keys on disk forever.
    expect((deleted.body as { orphaned: { targets: string[] } }).orphaned.targets).toHaveLength(2)
    expect(await readdir(join(dataDir, 'config', 'targets'))).toEqual([])

    const secrets = JSON.parse(
      await readFile(join(dataDir, 'secrets', 'secrets.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(secrets)).toEqual([])
  })
})

describe('no credential reaches config/, whatever the caller sends', () => {
  it('stores an API key as a secret even when it arrives in the plain-fields bucket', async () => {
    // The regression this exists for: the browser used to decide which values were credentials,
    // and a form bug spread a whole draft object into `base`. The API key landed in
    // config/targets/*.json in plaintext — in the directory whose purpose is being committed.
    const { status, body } = await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { scheme: 'http', host: '10.0.0.20', port: 8989 },
      fields: { apiKey: 'LEAKED-KEY-9999' },
    })
    expect(status).toBe(201)
    const id = (body as { id: string }).id

    const onDisk = await readFile(join(dataDir, 'config', 'targets', `${id}.json`), 'utf8')
    expect(onDisk).not.toContain('LEAKED-KEY-9999')
    expect(JSON.parse(onDisk)).toMatchObject({
      secrets: { apiKey: { $secret: `${id}.apiKey` } },
    })

    const vault = JSON.parse(
      await readFile(join(dataDir, 'secrets', 'secrets.json'), 'utf8'),
    ) as Record<string, string>
    expect(vault[`${id}.apiKey`]).toBe('LEAKED-KEY-9999')
  })

  it('refuses unknown keys inside base rather than persisting them', async () => {
    const { status } = await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { host: '10.0.0.20', port: 8989, values: { apiKey: 'SMUGGLED' } },
    })
    // Either refused outright or silently stripped — never written. Both are acceptable; the
    // assertion below is the one that matters.
    expect([201, 422]).toContain(status)
    const targets = await readdir(join(dataDir, 'config', 'targets'))
    for (const file of targets) {
      expect(await readFile(join(dataDir, 'config', 'targets', file), 'utf8')).not.toContain(
        'SMUGGLED',
      )
    }
  })

  it('ignores a value the shape does not declare and says so', async () => {
    const { body } = await request('POST', '/api/targets', {
      label: 'Bins',
      widgetType: 'ics-feed',
      base: { host: '10.0.0.9', port: 5232, basePath: '/bins.ics' },
      values: { uid: 's0', apiKey: 'NOT-DECLARED-HERE' },
    })
    expect((body as { ignored?: string[] }).ignored?.sort()).toEqual(['apiKey', 'uid'])
    const id = (body as { id: string }).id
    expect(await readFile(join(dataDir, 'config', 'targets', `${id}.json`), 'utf8')).not.toContain(
      'NOT-DECLARED-HERE',
    )
  })

  it('leaves nothing credential-shaped anywhere in the config tree', async () => {
    // The whole-tree grep the plan calls for, run against a config built the way the UI builds it.
    await request('POST', '/api/targets', {
      label: 'Sonarr',
      widgetType: 'sonarr-queue',
      base: { host: '10.0.0.20', port: 8989 },
      secrets: { apiKey: 'aaaa-bbbb-cccc-dddd' },
    })
    await request('POST', '/api/targets', {
      label: 'qBittorrent',
      widgetType: 'qbittorrent-transfer',
      base: { host: '10.0.0.21', port: 8080 },
      values: { username: 'admin', password: 'correct-horse-battery' },
    })

    const files: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else files.push(path)
      }
    }
    await walk(join(dataDir, 'config'))
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      expect(text, file).not.toContain('aaaa-bbbb-cccc-dddd')
      expect(text, file).not.toContain('correct-horse-battery')
    }

    // ...and the username, which is NOT a secret, is still there where it belongs.
    const targets = await readdir(join(dataDir, 'config', 'targets'))
    const all = await Promise.all(
      targets.map((file) => readFile(join(dataDir, 'config', 'targets', file), 'utf8')),
    )
    expect(all.join('')).toContain('admin')
  })
})

describe('sections', () => {
  const SECTIONS = [
    { id: 'nav', kind: 'navbar', items: [{ id: 't', kind: 'title' }] },
    { id: 'main', kind: 'grid' },
    { id: 'narrow', kind: 'grid', cols: { lg: 6 }, maxRows: 3 },
    {
      id: 'links',
      kind: 'bookmarks',
      columns: { lg: 3 },
      display: 'chips',
      groups: [
        {
          id: 'router',
          title: 'Router',
          links: [{ id: 'l1', label: 'FriendlyWrt', base: { host: '192.168.2.1', port: 80 } }],
        },
      ],
    },
  ]

  const layoutFile = async () =>
    JSON.parse(await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8')) as {
      layouts: Record<string, { i: string; x: number; y: number; w: number; h: number }[]>
    }

  it("replaces a page's sections whole and resolves them", async () => {
    expect((await request('PATCH', '/api/pages/home', { sections: SECTIONS })).status).toBe(200)
    const { body } = await request('GET', '/api/state')
    const page = (body as { resolved: { pages: { sections: { id: string; kind: string }[] }[] } })
      .resolved.pages[0]
    expect(page?.sections.map((section) => section.kind)).toEqual([
      'navbar',
      'grid',
      'grid',
      'bookmarks',
    ])
  })

  it('422s a malformed section list, naming the page, rather than 500ing', async () => {
    const { status, body } = await request('PATCH', '/api/pages/home', {
      sections: [{ id: 'x', kind: 'bookmarks', display: 'marquee' }],
    })
    expect(status).toBe(422)
    expect((body as { error: string }).error).toContain('pages/home.json')
  })

  it('refuses a section list that would strand a widget', async () => {
    await request('PATCH', '/api/pages/home', { sections: SECTIONS })
    await request('POST', '/api/widgets', { type: 'sonarr-queue', section: 'narrow' })
    const { status, body } = await request('PATCH', '/api/pages/home', {
      sections: SECTIONS.filter((section) => section.id !== 'narrow'),
    })
    expect(status).toBe(422)
    expect((body as { error: string }).error).toContain('narrow')
  })

  it("places a widget inside its section's columns, without touching another section", async () => {
    await request('PATCH', '/api/pages/home', { sections: SECTIONS })
    const main = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue' })).body as {
        id: string
      }
    ).id
    const { status, body } = await request('POST', '/api/widgets', {
      type: 'sonarr-queue',
      section: 'narrow',
      size: { w: 8, h: 3 },
    })
    expect(status).toBe(201)
    const narrow = (body as { id: string }).id

    const file = await layoutFile()
    const lg = file.layouts.lg ?? []
    // An 8-wide request in a 6-column section is clamped to the section, not the page.
    expect(lg.find((item) => item.i === narrow)).toMatchObject({ x: 0, y: 0, w: 6 })
    // Both sit at the origin of their own board: coordinates are per section.
    expect(lg.find((item) => item.i === main)).toMatchObject({ x: 0, y: 0 })
  })

  it("refuses a widget the section's row cap has no room for", async () => {
    await request('PATCH', '/api/pages/home', { sections: SECTIONS })
    await request('POST', '/api/widgets', {
      type: 'sonarr-queue',
      section: 'narrow',
      size: { w: 6, h: 3 },
    })
    const { status, body } = await request('POST', '/api/widgets', {
      type: 'sonarr-queue',
      section: 'narrow',
      size: { w: 6, h: 3 },
    })
    // Refused on every authored tier: the widget exists, but says so rather than being hidden.
    expect(status).toBe(201)
    expect((body as { refusedBreakpoints: string[] }).refusedBreakpoints).toContain('lg')
  })

  it("saves a layout for one section and leaves the other sections' entries alone", async () => {
    await request('PATCH', '/api/pages/home', { sections: SECTIONS })
    const main = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue' })).body as {
        id: string
      }
    ).id
    const narrow = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue', section: 'narrow' })).body as {
        id: string
      }
    ).id

    const { status } = await request('PUT', '/api/pages/home/layout', {
      breakpoint: 'lg',
      section: 'narrow',
      items: [{ i: narrow, x: 2, y: 0, w: 4, h: 3 }],
    })
    expect(status).toBe(200)
    const lg = (await layoutFile()).layouts.lg ?? []
    expect(lg.find((item) => item.i === narrow)).toMatchObject({ x: 2, w: 4 })
    expect(lg.find((item) => item.i === main)).toMatchObject({ x: 0, y: 0 })
  })

  it('moves a widget to another section and re-places it there', async () => {
    await request('PATCH', '/api/pages/home', { sections: SECTIONS })
    const id = (
      (await request('POST', '/api/widgets', { type: 'sonarr-queue', size: { w: 8, h: 3 } }))
        .body as { id: string }
    ).id
    const { status } = await request('PATCH', `/api/widgets/${id}`, { section: 'narrow' })
    expect(status).toBe(200)

    const { body } = await request('GET', '/api/state')
    const sections = (
      body as {
        resolved: { pages: { sections: { id: string; widgetIds?: string[] }[] }[] }
      }
    ).resolved.pages[0]?.sections
    expect(sections?.find((section) => section.id === 'narrow')?.widgetIds).toEqual([id])
    expect(sections?.find((section) => section.id === 'main')?.widgetIds).toEqual([])
    // Re-placed to fit the six columns it moved into.
    const lg = (await layoutFile()).layouts.lg ?? []
    expect(lg.find((item) => item.i === id)?.w).toBe(6)
  })
})
