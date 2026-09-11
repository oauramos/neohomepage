import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import type { AppContext } from '../context.ts'
import { env } from '../env.ts'
import { createApiRoutes } from './api.ts'
import {
  AssetError,
  assetMime,
  BACKGROUNDS_SUBDIR,
  deleteBackground,
  isAssetId,
  listBackgrounds,
  MAX_ASSET_BYTES,
  saveBackground,
} from '../assets/store.ts'
import {
  assertAuthUsable,
  checkPassword,
  checkWrite,
  clearedCookie,
  issueSession,
  readAuthConfig,
  sessionCookie,
  verifySession,
  readCookie,
  SESSION_COOKIE,
  type AuthConfig,
} from './auth.ts'
import { formatEvent, KEEPALIVE_FRAME } from './events.ts'

/** HTTP routes. `GET /` serves the last published generation as a static file. */

export type AppOptions = {
  readonly context: AppContext
  readonly webDistDir?: string
  readonly auth?: AuthConfig
}

// Frames queued to a socket before its subscriber is dropped; a synchronous fan-out is bounded by
// the widget count, so a healthy client never gets near this.
const MAX_QUEUED_FRAMES = 64

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function streamFile(c: Context, path: string) {
  return stream(c, async (writable) => {
    for await (const chunk of createReadStream(path)) await writable.write(chunk as Uint8Array)
  })
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono()
  const { context } = options
  const auth = options.auth ?? readAuthConfig()
  assertAuthUsable(auth)

  // Registered before the routes so a route added later is protected by default.
  app.use('*', async (c, next) => {
    const decision = checkWrite(
      auth,
      {
        method: c.req.method,
        secFetchSite: c.req.header('sec-fetch-site'),
        origin: c.req.header('origin'),
        host: c.req.header('host'),
        contentType: c.req.header('content-type'),
        cookie: c.req.header('cookie'),
        forwardedUser: c.req.header('remote-user') ?? c.req.header('x-forwarded-user'),
        // Socket address only: a forwarded-for header would let anyone claim to be the trusted proxy.
        remoteAddress: (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
          ?.incoming?.socket?.remoteAddress,
      },
      Date.now(),
    )
    if (!decision.allowed) return c.json({ error: decision.reason }, decision.status)
    await next()
  })

  app.get('/api/auth', (c) =>
    c.json({
      mode: auth.mode,
      // Whether this request could write, so the editor can prompt for sign-in up front.
      authenticated:
        auth.mode === 'none' ||
        verifySession(auth, readCookie(c.req.header('cookie'), SESSION_COOKIE), Date.now()),
    }),
  )

  app.post('/api/auth/login', async (c) => {
    if (auth.mode !== 'password') return c.json({ error: 'password login is not enabled' }, 400)
    const body = (await c.req.json()) as { username?: string; password?: string }
    if (!checkPassword(auth, body.username ?? '', body.password ?? '')) {
      // Same message for a wrong username and a wrong password, so neither can be guessed alone.
      return c.json({ error: 'incorrect username or password' }, 401)
    }
    const secure =
      c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:'
    c.header('Set-Cookie', sessionCookie(issueSession(auth, Date.now()), auth.sessionTtlMs, secure))
    return c.json({ ok: true })
  })

  app.post('/api/auth/logout', (c) => {
    c.header('Set-Cookie', clearedCookie())
    return c.json({ ok: true })
  })

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      // Reachable without authentication, so nothing about paths, versions or services.
      uptimeSeconds: Math.round(process.uptime()),
    }),
  )

  // Falls back to the SPA shell when nothing has been published yet; the shell renders the same
  // component tree from the same state.
  app.get('/', async (c) => {
    const generation = await context.generations.current()
    if (generation !== null) {
      const html = await readFileIfExists(join(context.generations.path(generation), 'index.html'))
      if (html !== null) {
        c.header('X-Neo-Generation', String(generation))
        c.header('Cache-Control', 'no-cache')
        return c.html(html)
      }
    }

    const shell =
      options.webDistDir === undefined
        ? null
        : await readFileIfExists(join(options.webDistDir, 'index.html'))
    if (shell !== null) {
      c.header('Cache-Control', 'no-cache')
      return c.html(shell)
    }

    return c.text(
      'neohomepage is running, but nothing has been published yet.\n' +
        `data dir: ${env.dataDir}\n` +
        'Run `neo publish`, or open the editor.\n',
      200,
    )
  })

  /** Built assets, content-hashed by Vite and therefore safe to cache forever. */
  app.get('/_app/*', async (c) => {
    if (options.webDistDir === undefined) return c.notFound()
    const requested = decodeURIComponent(c.req.path.slice('/_app/'.length))
    // Normalise, then re-check the prefix so `..` cannot escape the dist directory.
    const resolvedPath = normalize(join(options.webDistDir, requested))
    if (!resolvedPath.startsWith(normalize(options.webDistDir))) return c.notFound()
    if (!(await isFile(resolvedPath))) return c.notFound()
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    c.header('Content-Type', contentType(resolvedPath))
    return streamFile(c, resolvedPath)
  })

  app.get('/api/state', async (c) => {
    const { resolved, revision } = await context.state()
    const pending = await context.pending()
    return c.json({
      revision,
      generation: pending.generation,
      pending: pending.pending,
      resolved,
      data: context.widgetData(),
    })
  })

  // The client names only a widget id; URL, path, headers and method come from the widget's
  // manifest. This is the only request shape that can reach an upstream.
  app.post('/api/widgets/:id/refresh', async (c) => {
    const ok = await context.refreshWidget(c.req.param('id'))
    if (!ok) return c.json({ error: 'unknown widget' }, 404)
    return c.json({ data: context.widgetData() })
  })

  app.post('/api/publish', async (c) => {
    const result = await context.publishNow('ui')
    return c.json({
      generation: result.generation,
      bytes: result.bytes,
      durationMs: result.durationMs,
    })
  })

  // Only the backgrounds subdirectory, and only ids in the shape the store emits
  // (32 hex + known extension); no client-supplied path is ever joined.
  app.get('/assets/backgrounds/:id', async (c) => {
    const id = c.req.param('id')
    if (!isAssetId(id)) return c.notFound()
    const path = join(env.assetsDir, BACKGROUNDS_SUBDIR, id)
    if (!(await isFile(path))) return c.notFound()
    // Content addressed, so the bytes behind an id can never change: cache them forever.
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    c.header('Content-Type', assetMime(id))
    // A stranger uploaded this file: stop the browser sniffing it as something else.
    c.header('X-Content-Type-Options', 'nosniff')
    return streamFile(c, path)
  })

  // CSP on top of the store's type check: an SVG that slipped through must not run anything on
  // this origin when opened directly.
  app.get('/assets/icons/:slug', async (c) => {
    const file = context.icons().fileFor(c.req.param('slug'))
    if (file === null) return c.json({ error: 'unknown icon' }, 404)
    const bytes = await readFile(file.path)
    return c.body(bytes, 200, {
      'content-type': file.mime,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
  })

  app.get('/api/assets/backgrounds', async (c) =>
    c.json({ assets: await listBackgrounds(env.assetsDir) }),
  )

  // Raw bytes rather than multipart: a multipart filename would be attacker-controlled text on
  // its way to a path.
  app.post('/api/assets/backgrounds', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (declared > MAX_ASSET_BYTES) {
      return c.json({ error: `larger than ${String(MAX_ASSET_BYTES / 1024 / 1024)} MB` }, 413)
    }
    const body = new Uint8Array(await c.req.arrayBuffer())
    try {
      return c.json(await saveBackground(env.assetsDir, body), 201)
    } catch (error) {
      if (error instanceof AssetError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })

  app.delete('/api/assets/backgrounds/:id', async (c) => {
    const removed = await deleteBackground(env.assetsDir, c.req.param('id'))
    return removed ? c.json({ ok: true }) : c.json({ error: 'unknown asset' }, 404)
  })

  // One SSE connection per tab; the first frame is the current state so a late client is not blank.
  app.get('/api/events', (c) => {
    if (context.hub.atCapacity) {
      return c.text('too many event subscribers', 503)
    }

    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('Connection', 'keep-alive')
    // Nginx buffers text/event-stream by default; this header disables it.
    c.header('X-Accel-Buffering', 'no')

    return stream(c, async (writable) => {
      let closed = false
      let queued = 0
      const { release } = context.hub.add({
        send: (event) => {
          if (closed) throw new Error('closed')
          // StreamingApi.write() never rejects, so backlog is the only signal a stalled tab gives.
          if (queued >= MAX_QUEUED_FRAMES) throw new Error('subscriber stopped reading')
          queued++
          void writable.write(formatEvent(event)).finally(() => {
            queued--
          })
        },
        close: () => {
          closed = true
          // Drops queued frames; the browser's EventSource reconnects and gets a fresh hello.
          writable.abort()
        },
      })

      writable.onAbort(() => {
        closed = true
        release()
      })

      await writable.write(formatEvent({ type: 'hello', data: context.widgetData() }))

      while (!closed) {
        await new Promise((settle) => setTimeout(settle, context.hub.keepAliveMs))
        if (closed) break
        try {
          await writable.write(KEEPALIVE_FRAME)
        } catch {
          break
        }
      }
      release()
    })
  })

  app.route('/api', createApiRoutes({ context }))

  return app
}

function contentType(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}
