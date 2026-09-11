import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Secret resolution. Config stores only a reference (`{"$secret": "sonarr.apiKey"}`); the value is
 * looked up right before an outbound request from, in order, `NEOHOMEPAGE_SECRET_<NAME>`, the file
 * at `NEOHOMEPAGE_SECRET_<NAME>_FILE`, then `secrets/secrets.json` (written by the UI, mode 0600).
 */

export type Vault = {
  get(name: string): string | undefined
  /**
   * Answered by name rather than by enumerating sources: `NEOHOMEPAGE_SECRET_A_B` could be `a.b`
   * or `a-b`, so a scan of `process.env` would miss values that are set.
   */
  has(name: string): boolean
}

/** `sonarr.apiKey` -> `NEOHOMEPAGE_SECRET_SONARR_APIKEY` */
export function environmentVariableName(secretName: string): string {
  return `NEOHOMEPAGE_SECRET_${secretName.replace(/[.-]/g, '_').toUpperCase()}`
}

export function secretsFile(secretsDir: string): string {
  return join(secretsDir, 'secrets.json')
}

/** `secrets.json` as a plain object; `{}` when it holds something else, null when unreadable. */
export async function readSecretsFile(secretsDir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(secretsFile(secretsDir), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return null
  }
}

export async function loadSecrets(secretsDir: string): Promise<Vault> {
  // No secrets file is the normal state on a fresh install.
  const stored = (await readSecretsFile(secretsDir)) ?? {}

  const cache = new Map<string, string>()

  const readFromFile = (path: string): string | undefined => {
    try {
      // Sync on purpose: runs once per secret and is cached, for a file that is usually absent.
      return readFileSync(path, 'utf8').trim()
    } catch {
      return undefined
    }
  }

  const lookup = (name: string): string | undefined => {
    const variable = environmentVariableName(name)
    const fromEnv = process.env[variable]
    const filePath = process.env[`${variable}_FILE`]
    const fromFile = filePath === undefined ? undefined : readFromFile(filePath)
    const raw = stored[name]
    const fromStore = typeof raw === 'string' ? raw : undefined

    const value = fromEnv ?? fromFile ?? fromStore
    return value === undefined || value === '' ? undefined : value
  }

  return {
    get(name: string): string | undefined {
      const cached = cache.get(name)
      if (cached !== undefined) return cached
      const value = lookup(name)
      if (value === undefined) return undefined
      cache.set(name, value)
      return value
    },
    has(name: string): boolean {
      // Does not cache: checking that a credential exists is not using it.
      return cache.has(name) || lookup(name) !== undefined
    },
  }
}

/**
 * Names in `secrets/secrets.json`, the only enumerable source; an unused environment variable is
 * not an orphan.
 */
export async function storedSecretNames(secretsDir: string): Promise<string[]> {
  return Object.keys((await readSecretsFile(secretsDir)) ?? {}).sort()
}
