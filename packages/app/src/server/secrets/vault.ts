import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Secret resolution.
 *
 * Config stores only a reference — `{"$secret": "sonarr.apiKey"}` — and the value is looked up
 * here, immediately before an outbound request. Three sources, in order, so a restore never
 * requires the values to have been in the repository:
 *
 *   1. NEOHOMEPAGE_SECRET_<NAME>       an environment variable
 *   2. NEOHOMEPAGE_SECRET_<NAME>_FILE  a Docker secret or mounted file
 *   3. secrets/secrets.json            the file the UI writes, mode 0600, never committed
 *
 * Environment first is deliberate: it is the recommended way for credentials to survive a wipe,
 * because they then live in the compose file or systemd unit rather than anywhere near git.
 */

export type Vault = {
  get(name: string): string | undefined
  /** Names that resolved, for diagnostics. Never the values. */
  names(): string[]
}

/** `sonarr.apiKey` -> `NEOHOMEPAGE_SECRET_SONARR_APIKEY` */
export function environmentVariableName(secretName: string): string {
  return `NEOHOMEPAGE_SECRET_${secretName.replace(/[.-]/g, '_').toUpperCase()}`
}

export async function loadSecrets(secretsDir: string): Promise<Vault> {
  let stored: Record<string, unknown> = {}
  try {
    const text = await readFile(join(secretsDir, 'secrets.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stored = parsed as Record<string, unknown>
    }
  } catch {
    // No secrets file is the normal state on a fresh install, not an error.
  }

  const cache = new Map<string, string>()
  const resolved = new Set<string>()

  const readFromFile = (path: string): string | undefined => {
    try {
      // Sync on purpose: it runs once per secret, is cached, and the alternative is making every
      // caller async for a file that is usually absent.
      return readFileSync(path, 'utf8').trim()
    } catch {
      return undefined
    }
  }

  return {
    get(name: string): string | undefined {
      const cached = cache.get(name)
      if (cached !== undefined) return cached

      const variable = environmentVariableName(name)
      const fromEnv = process.env[variable]
      const filePath = process.env[`${variable}_FILE`]
      const fromFile = filePath === undefined ? undefined : readFromFile(filePath)
      const fromStore = typeof stored[name] === 'string' ? (stored[name] as string) : undefined

      const value = fromEnv ?? fromFile ?? fromStore
      if (value !== undefined && value !== '') {
        cache.set(name, value)
        resolved.add(name)
        return value
      }
      return undefined
    },
    names(): string[] {
      return [...resolved].sort()
    },
  }
}
