import { setTimeout } from 'node:timers'
import { serve } from '@hono/node-server'
import { createApp } from './http/app.ts'
import { env } from './env.ts'
import { seedDataDirectory } from './store/seed.ts'
import { seedStarterConfig } from './store/starter.ts'

/**
 * Boot order, which later phases fill in:
 *   env -> lock -> migrate -> resolve -> publish -> listen
 * Today it is env -> listen. Keeping the shape visible is cheaper than rediscovering it.
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

  const app = createApp()

  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    console.log(`neohomepage listening on http://${formatHost(info.address)}:${info.port}`)
    console.log(`data dir: ${env.dataDir}`)
  })

  // A container that ignores SIGTERM gets SIGKILLed mid-write. Flushing pending writes lands
  // with the config store in F4; the handler exists from the start so it is never forgotten.
  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`\n${signal} received, shutting down`)
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
