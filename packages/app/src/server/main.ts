import { resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { serve } from '@hono/node-server'
import { createApp } from './http/app.ts'
import { createContext } from './context.ts'
import { env } from './env.ts'
import { seedDataDirectory } from './store/seed.ts'
import { seedStarterConfig } from './store/starter.ts'
import { ConfigTooNewError, migrateConfig } from './store/migrations.ts'

/**
 * Boot order: env, seed, migrate, load, publish, listen. Publishing before listening means the
 * first request is served from a file that already exists.
 */
async function main(): Promise<void> {
  // Seed first so secrets/ and state/ are gitignored before either exists.
  const seeded = await seedDataDirectory({
    dataDir: env.dataDir,
    configDir: env.configDir,
    assetsDir: env.assetsDir,
    secretsDir: env.secretsDir,
    stateDir: env.stateDir,
  })
  const starter = await seedStarterConfig(env.configDir)
  for (const path of [...seeded, ...starter]) console.log(`seeded ${path}`)

  // Migrate before anything reads the tree. Config from a newer build stops the boot here:
  // parsing it would drop unknown fields and the next save would write that loss to disk.
  const migration = await migrateConfig({
    configDir: env.configDir,
    stateDir: env.stateDir,
    now: () => new Date().toISOString().replace(/[:.]/g, '-'),
  })
  if (migration.migrated) {
    console.log(`migrated config from schemaVersion ${migration.from} to ${migration.to}`)
    for (const step of migration.applied) console.log(`  ${step}`)
    console.log(`  the previous tree is in ${migration.backupPath}`)
  }

  const webDistDir =
    process.env.NEOHOMEPAGE_WEB_DIST ?? resolve(import.meta.dirname, '../../dist/web')

  const context = await createContext({
    catalogDir: env.catalogDir,
    webDistDir,
    ...(process.env.NEOHOMEPAGE_PUBLISH_MODE === 'manual'
      ? { publishMode: 'manual' as const }
      : {}),
  })
  await context.reload()

  // The generation may be missing (first boot) or stale (config edited with the app down).
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

// A config from a newer release (restored onto an older build on a rollback) gets a one-line
// "upgrade" message, not a parser stack trace.
try {
  await main()
} catch (error) {
  if (error instanceof ConfigTooNewError) {
    console.error(`neohomepage cannot start: ${error.message}`)
    process.exit(78) // EX_CONFIG, so a supervisor can tell this from a crash.
  }
  throw error
}
