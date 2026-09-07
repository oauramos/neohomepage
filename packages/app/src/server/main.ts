import { resolve } from 'node:path'
import { setTimeout } from 'node:timers'
import { serve } from '@hono/node-server'
import { createApp } from './http/app.ts'
import { createContext } from './context.ts'
import { env } from './env.ts'
import { seedDataDirectory } from './store/seed.ts'
import { seedStarterConfig } from './store/starter.ts'

/**
 * Boot order: env, seed, load, resolve, publish, listen.
 *
 * Publishing before listening means the first request is answered by a file that already exists,
 * rather than by a render happening while someone waits.
 */
async function main(): Promise<void> {
  // Seeding first means `git init` on the data directory is safe before the user has read
  // anything: secrets/ and state/ are already excluded by the time either exists.
  const seeded = await seedDataDirectory({
    dataDir: env.dataDir,
    configDir: env.configDir,
    assetsDir: env.assetsDir,
    secretsDir: env.secretsDir,
    stateDir: env.stateDir,
  })
  const starter = await seedStarterConfig(env.configDir)
  for (const path of [...seeded, ...starter]) console.log(`seeded ${path}`)

  const webDistDir =
    process.env.NEOHOMEPAGE_WEB_DIST ?? resolve(import.meta.dirname, '../../dist/web')
  const catalogDir = process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolve(process.cwd(), 'catalog')

  const context = await createContext({
    catalogDir,
    webDistDir,
    ...(process.env.NEOHOMEPAGE_PUBLISH_MODE === 'manual'
      ? { publishMode: 'manual' as const }
      : {}),
  })
  await context.reload()

  // A generation may be missing (first boot) or stale (someone edited config with the app down).
  // Either way, publishing now costs milliseconds and means `GET /` serves a file immediately.
  const pending = await context.pending()
  if (pending.pending) {
    const result = await context.publishNow('boot', 'boot')
    console.log(
      `published generation ${result.generation} (${result.bytes} bytes, ${result.durationMs}ms)`,
    )
  }

  context.scheduler.start()
  context.watcher.start()

  const app = createApp({ context, webDistDir })
  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    console.log(`neohomepage listening on http://${formatHost(info.address)}:${info.port}`)
    console.log(`data dir: ${env.dataDir}`)
  })

  // A container that ignores SIGTERM gets SIGKILLed mid-write.
  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`\n${signal} received, shutting down`)
    void context.shutdown()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function formatHost(address: string): string {
  if (address === '::' || address === '0.0.0.0') return 'localhost'
  return address.includes(':') ? `[${address}]` : address
}

await main()
