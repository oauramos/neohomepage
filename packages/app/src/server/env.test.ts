import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

/** env is read once at module load, so each case re-imports it with a fresh module registry. */
async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules()
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NEOHOMEPAGE_')) delete process.env[key]
  }
  Object.assign(process.env, overrides)
  try {
    return (await import('./env.ts')).env
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NEOHOMEPAGE_')) delete process.env[key]
    }
    Object.assign(process.env, saved)
  }
}

afterEach(() => vi.resetModules())

describe('data directories', () => {
  it('derives all four from one data dir, so one `git init` covers the backup', async () => {
    const env = await loadEnv({ NEOHOMEPAGE_DATA_DIR: '/srv/neo' })
    expect(env.dataDir).toBe('/srv/neo')
    expect(env.configDir).toBe('/srv/neo/config')
    expect(env.assetsDir).toBe('/srv/neo/assets')
    expect(env.secretsDir).toBe('/srv/neo/secrets')
    expect(env.stateDir).toBe('/srv/neo/state')
  })

  it('defaults to ./data so running from source needs no setup', async () => {
    const env = await loadEnv({})
    expect(env.dataDir).toBe(resolve('data'))
    expect(env.configDir).toBe(resolve('data/config'))
  })

  it('lets a single directory be relocated without moving the others', async () => {
    const env = await loadEnv({
      NEOHOMEPAGE_DATA_DIR: '/srv/neo',
      NEOHOMEPAGE_STATE_DIR: '/var/cache/neo',
    })
    expect(env.stateDir).toBe('/var/cache/neo')
    expect(env.configDir).toBe('/srv/neo/config')
  })

  it('always returns absolute paths', async () => {
    const env = await loadEnv({ NEOHOMEPAGE_DATA_DIR: './relative' })
    expect(env.dataDir).toBe(resolve('relative'))
  })
})

describe('port', () => {
  it('defaults to 7575', async () => {
    expect((await loadEnv({})).port).toBe(7575)
  })

  it('rejects a non-numeric port loudly instead of silently listening on 7575', async () => {
    await expect(loadEnv({ NEOHOMEPAGE_PORT: 'eight thousand' })).rejects.toThrow(
      /NEOHOMEPAGE_PORT must be a non-negative integer/,
    )
  })
})
