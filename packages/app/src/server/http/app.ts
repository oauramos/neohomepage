import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { Hono } from 'hono'
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

/**
 * The HTTP surface.
 *
 * `GET /` serves a file. Not a render, not a cache lookup with a fallback — a file that was
 * written when the config last changed. That is what makes the dashboard's time-to-first-byte
 * independent of how many services it displays or whether any of them are up.
 */

export type AppOptions = {
  readonly context: AppContext
  readonly webDistDir?: string
  readonly auth?: AuthConfig
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono()
  const { context } = options
  const auth = options.auth ?? readAuthConfig()
  assertAuthUsable(auth)

  /**
   * One gate in front of every mutating request.
   *
   * Registered before the routes rather than repeated in each handler, so a route added later is
   * protected by default. There is a test that enumerates the router and fails if any non-GET
   * route escapes this.
   */
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
        // Only the SOCKET address, never a forwarded-for header: reading the header here would
        // let anyone claim to be the trusted proxy, which is the failure the list exists to stop.
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
      // Whether THIS request could write. The editor uses it to show a sign-in prompt instead of
      // letting someone fill in a form that will be refused on submit.
      authenticated:
        auth.mode === 'none' ||
        verifySession(auth, readCookie(c.req.header('cookie'), SESSION_COOKIE), Date.now()),
    }),
  )

  app.post('/api/auth/login', async (c) => {
    if (auth.mode !== 'password') return c.json({ error: 'password login is not enabled' }, 400)
    const body = (await c.req.json()) as { username?: string; password?: string }
    if (!checkPassword(auth, body.username ?? '', body.password ?? '')) {
      // One message for both a wrong username and a wrong password: distinguishing them tells an
      // attacker which half to keep guessing.
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
      // Deliberately reports nothing about paths, versions or configured services: this endpoint
      // is reachable without authentication.
      uptimeSeconds: Math.round(process.uptime()),
    }),
  )

  /**
   * The published page.
   *
   * Falls back to the SPA shell when no generation exists yet — a first boot, or a render that
   * failed before anything was ever published. The shell fetches the same state and renders the
   * same component tree, so the two paths cannot look different.
   */
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
    // Normalising and then re-checking the prefix is what stops `..` escaping the dist directory.
    const resolvedPath = normalize(join(options.webDistDir, requested))
    if (!resolvedPath.startsWith(normalize(options.webDistDir))) return c.notFound()
    try {
      const info = await stat(resolvedPath)
      if (!info.isFile()) return c.notFound()
    } catch {
      return c.notFound()
    }
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    c.header('Content-Type', contentType(resolvedPath))
    return stream(c, async (writable) => {
      const readable = createReadStream(resolvedPath)
      for await (const chunk of readable) await writable.write(chunk as Uint8Array)
    })
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

  /**
   * Refresh one widget.
   *
   * The client names a widget id. It cannot name a URL, a path, a header or a method — the server
   * derives all four from the widget's target and its manifest. That is the invariant the whole
   * egress design rests on, and this is the only shape of request that can reach an upstream.
   */
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

  /**
   * Serve an uploaded background.
   *
   * `data/assets/` has been created, backed up and walked by doctor since v1 with nothing serving
   * it, which is why setting a background by hand produced a 404 and a still-white page. This is
   * that route — and it is deliberately narrow: only the backgrounds subdirectory, and only ids in
   * the shape the store emits. There is no path to traverse because there is no path from the
   * client, only an id that must match a 32-hex-plus-known-extension pattern.
   */
  app.get('/assets/backgrounds/:id', async (c) => {
    const id = c.req.param('id')
    if (!isAssetId(id)) return c.notFound()
    const path = join(env.assetsDir, BACKGROUNDS_SUBDIR, id)
    try {
      const info = await stat(path)
      if (!info.isFile()) return c.notFound()
    } catch {
      return c.notFound()
    }
    // Content addressed, so the bytes behind an id can never change: cache them forever.
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    c.header('Content-Type', assetMime(id))
    // An image served from the dashboard's own origin is still a file a stranger uploaded. This
    // stops a browser from second-guessing the type and running it as something else.
    c.header('X-Content-Type-Options', 'nosniff')
    return stream(c, async (writable) => {
      const readable = createReadStream(path)
      for await (const chunk of readable) await writable.write(chunk as Uint8Array)
    })
  })

  /**
   * A cached service icon. Served with a sandboxing policy on top of the type check the store
   * made when it saved the file: an SVG is a document, and one that ever slipped through must not
   * be able to run anything on this origin even when opened directly.
   */
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

  /**
   * Upload one image as raw bytes.
   *
   * Raw rather than multipart: multipart carries a filename, and a filename is the one field here
   * that would be attacker-controlled text on its way to a path. Not accepting it is simpler than
   * sanitising it.
   */
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

  /**
   * Live updates.
   *
   * One connection per tab. The first frame is the current state, so a client that connects late
   * does not sit blank waiting for something to change.
   */
  app.get('/api/events', (c) => {
    if (context.hub.atCapacity) {
      // Refusing is better than accepting and degrading everyone already connected.
      return c.text('too many event subscribers', 503)
    }

    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('Connection', 'keep-alive')
    // Nginx buffers text/event-stream by default, which turns live updates into batches minutes
    // apart. This is the header that stops it.
    c.header('X-Accel-Buffering', 'no')

    return stream(c, async (writable) => {
      let closed = false
      const { release } = context.hub.add({
        send: (event) => {
          if (closed) throw new Error('closed')
          void writable.write(formatEvent(event))
        },
        close: () => {
          closed = true
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

  app.route('/api', createApiRoutes({ context, catalog: () => context.catalog() }))

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
