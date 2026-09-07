import { resolve } from 'node:path'

/**
 * Every path is derived from one data directory so that `git init $NEOHOMEPAGE_DATA_DIR` is the
 * whole backup story, while each subdirectory stays individually overridable for people who want
 * `state/` on fast local disk and `config/` on a network share.
 *
 * The code default is `./data` because that is what makes `pnpm dev` work with no setup. The
 * container image sets NEOHOMEPAGE_DATA_DIR=/data explicitly rather than the code guessing
 * whether it is inside a container.
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

  host: process.env.NEOHOMEPAGE_HOST ?? '::',
  port: int('NEOHOMEPAGE_PORT', 7575),

  nodeEnv: process.env.NODE_ENV ?? 'development',
  get isProduction(): boolean {
    return this.nodeEnv === 'production'
  },
} as const

export type Env = typeof env
