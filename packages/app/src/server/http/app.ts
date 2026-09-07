import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { AppContext } from '../context.ts'
import { env } from '../env.ts'
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

  app.post('/api/publish', async (c) => {
    const result = await context.publishNow('ui')
    return c.json({
      generation: result.generation,
      bytes: result.bytes,
      durationMs: result.durationMs,
    })
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
