import { resolve } from 'node:path'

/**
 * Every path derives from one data directory so `git init $NEOHOMEPAGE_DATA_DIR` backs up
 * everything; each subdirectory stays individually overridable. The container image sets
 * NEOHOMEPAGE_DATA_DIR=/data explicitly rather than the code guessing it is in a container.
 */
function dir(name: string, fallback: string): string {
  const value = process.env[name]
  return resolve(value && value.length > 0 ? value : fallback)
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

const dataDir = dir('NEOHOMEPAGE_DATA_DIR', 'data')

export const env = {
  dataDir,
  /** Committed. Sparse JSON, human-diffable, never contains a secret value. */
  configDir: dir('NEOHOMEPAGE_CONFIG_DIR', `${dataDir}/config`),
  /** Committed. Content-addressed binaries. */
  assetsDir: dir('NEOHOMEPAGE_ASSETS_DIR', `${dataDir}/assets`),
  /** Never committed. 0600. */
  secretsDir: dir('NEOHOMEPAGE_SECRETS_DIR', `${dataDir}/secrets`),
  /** Never committed. Fully regenerable — delete it and the app rebuilds it on boot. */
  stateDir: dir('NEOHOMEPAGE_STATE_DIR', `${dataDir}/state`),
  /** The widget manifests this build ships. Not under the data dir: it is code, not user data. */
  catalogDir: dir('NEOHOMEPAGE_CATALOG_DIR', 'catalog'),

  host: process.env.NEOHOMEPAGE_HOST ?? '::',
  port: int('NEOHOMEPAGE_PORT', 7575),
} as const

export type Env = typeof env
