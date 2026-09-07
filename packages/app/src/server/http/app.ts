import { Hono } from 'hono'
import { env } from '../env.ts'

export function createApp(): Hono {
  const app = new Hono()

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      // Deliberately does not report paths or versions: /api/health is reachable without auth.
      uptimeSeconds: Math.round(process.uptime()),
    }),
  )

  // Placeholder until F7 wires the generation pointer. The SPA shell is the fallback path and
  // will land in F8; until then this is what proves the process is serving.
  app.get('/', (c) =>
    c.text(
      'neohomepage is running.\n' +
        `data dir: ${env.dataDir}\n` +
        'No generation has been published yet — that lands in F7.\n',
    ),
  )

  return app
}
