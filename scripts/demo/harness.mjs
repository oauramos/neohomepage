/**
 * A disposable homelab: one stub per widget, with the real neohomepage server on a temporary data
 * directory in front of it.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { TILES, VALUES } from './board.mjs'

export const ROOT = resolve(import.meta.dirname, '../..')
const CATALOG = join(ROOT, 'catalog')

const APP_PORT = 7581
const STUB_BASE = 9820

async function manifest(slug) {
  return JSON.parse(await readFile(join(CATALOG, slug, 'manifest.json'), 'utf8'))
}

/**
 * One stub per widget: Sonarr and Radarr both answer `/api/v3/queue` with different fixtures, so a
 * shared stub could not route.
 */
async function startStub(slug, port) {
  const spec = await manifest(slug)
  const operations = await Promise.all(
    Object.entries(spec.operations ?? {}).map(async ([op, definition]) => {
      const body = await readFile(join(CATALOG, slug, 'fixtures', `${op}.upstream.json`), 'utf8')
      return { op, decode: definition.decode ?? 'json', body }
    }),
  )
  // The stub answers every request with the first operation; each board widget only uses one.
  const answer = operations[0]
  // qBittorrent's session-exchange login is answered so the real session code runs.
  const auth = spec.target?.auth
  const loginPath = auth?.kind === 'session-exchange' ? auth.loginPath : null

  const server = createServer((request, response) => {
    if (loginPath !== null && request.url?.split('?')[0] === loginPath) {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': 'SID=demo-session; Path=/; HttpOnly',
      })
      response.end('Ok.')
      return
    }
    if (answer === undefined) {
      response.writeHead(404).end()
      return
    }
    const type = answer.decode === 'json' ? 'application/json' : 'text/plain'
    response.writeHead(200, { 'content-type': type })
    // A `text` operation wants the page, not the JSON that recorded it.
    response.end(answer.decode === 'json' ? answer.body : 'demo')
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return server
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`nothing answered at ${url}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

const json = (baseURL, path, method, body) =>
  fetch(`${baseURL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Seed the board, then wait until every tile has actually fetched something to show. */
async function seed(baseURL, ports) {
  await json(baseURL, '/api/dashboard', 'PATCH', {
    title: 'Homelab',
    // Controls fading out mid-take look like a glitch in the recording.
    features: { autoHideControls: false },
  })

  const ids = []
  for (const tile of TILES) {
    const spec = VALUES[tile.slug] ?? { values: {} }
    const target = await json(baseURL, '/api/targets', 'POST', {
      label: tile.title,
      widgetType: tile.slug,
      base: { scheme: 'http', host: '127.0.0.1', port: ports[tile.slug] },
      values: spec.values,
    })
    const { id: targetId } = await target.json()
    const widget = await json(baseURL, '/api/widgets', 'POST', {
      type: tile.slug,
      title: tile.title,
      targetId,
      config: spec.config ?? {},
      size: { w: tile.w, h: tile.h },
    })
    const { id } = await widget.json()
    ids.push({ id, tile })
  }

  // Auto-placement packs tiles in arrival order; the demo needs the fixed layout.
  await json(baseURL, '/api/pages/home/layout', 'PUT', {
    breakpoint: 'lg',
    items: ids.map(({ id, tile }) => ({ i: id, x: tile.x, y: tile.y, w: tile.w, h: tile.h })),
  })
  await json(baseURL, '/api/publish', 'POST', {})

  // Published HTML renders tiles pending until the poller has fetched; wait so the recording is
  // not of the empty state.
  const deadline = Date.now() + 30_000
  for (;;) {
    const state = await (await fetch(`${baseURL}/api/state`)).json()
    const filled = ids.filter(({ id }) => state.data?.[id] !== undefined)
    if (filled.length === ids.length) break
    if (Date.now() > deadline) {
      throw new Error(`only ${filled.length}/${ids.length} widgets ever fetched anything`)
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  await json(baseURL, '/api/publish', 'POST', {})
  return ids
}

export async function startHarness() {
  const slugs = [...new Set(TILES.map((tile) => tile.slug))]
  const ports = Object.fromEntries(slugs.map((slug, index) => [slug, STUB_BASE + index]))
  const stubs = await Promise.all(slugs.map((slug) => startStub(slug, ports[slug])))

  const dataDir = await mkdtemp(join(tmpdir(), 'neo-demo-'))
  const app = spawn(process.execPath, [join(ROOT, 'packages/app/src/server/main.ts')], {
    cwd: join(ROOT, 'packages/app'),
    env: {
      ...process.env,
      NEOHOMEPAGE_DATA_DIR: dataDir,
      NEOHOMEPAGE_CATALOG_DIR: CATALOG,
      NEOHOMEPAGE_PORT: String(APP_PORT),
      NEOHOMEPAGE_HOST: '127.0.0.1',
      NEOHOMEPAGE_PUBLISH_MODE: 'manual',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  app.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

  const baseURL = `http://127.0.0.1:${APP_PORT}`
  await waitFor(`${baseURL}/api/state`)
  const widgets = await seed(baseURL, ports)

  return {
    baseURL,
    widgets,
    stop: async () => {
      app.kill('SIGTERM')
      await once(app, 'exit')
      for (const stub of stubs) stub.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}
