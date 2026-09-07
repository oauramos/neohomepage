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
  /**
   * Can this name be resolved right now?
   *
   * Distinct from `resolvedNames()`, and the distinction is load-bearing. `resolvedNames()` lists
   * what has already been asked for, which is empty in a fresh process — two callers used it to
   * mean "what is set" and got "nothing": `neo doctor` reported every stored credential missing,
   * and the editor never showed a saved secret as saved after a restart.
   *
   * Answering by NAME rather than by enumeration is what makes this correct: an environment
   * variable cannot be mapped back to a secret name (`NEOHOMEPAGE_SECRET_A_B` could be `a.b` or
   * `a-b`), so a list built by scanning `process.env` would silently miss values that are set.
   */
  has(name: string): boolean
  /** Names resolved so far. Diagnostics only — never a source of truth about what is set. */
  resolvedNames(): string[]
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

  const lookup = (name: string): string | undefined => {
    const variable = environmentVariableName(name)
    const fromEnv = process.env[variable]
    const filePath = process.env[`${variable}_FILE`]
    const fromFile = filePath === undefined ? undefined : readFromFile(filePath)
    const fromStore = typeof stored[name] === 'string' ? (stored[name] as string) : undefined

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
      resolved.add(name)
      return value
    },
    has(name: string): boolean {
      // Deliberately does NOT mark the name resolved or cache the value: asking whether a
      // credential exists is not the same as using one, and the audit trail should say so.
      return cache.has(name) || lookup(name) !== undefined
    },
    resolvedNames(): string[] {
      return [...resolved].sort()
    },
  }
}

/**
 * The names actually written in `secrets/secrets.json`.
 *
 * The one enumerable source, and the only one an orphan check can honestly use: an unused
 * environment variable is the user's business, and often deliberate — one compose file serving
 * several installs, say.
 */
export async function storedSecretNames(secretsDir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(secretsDir, 'secrets.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.keys(parsed as Record<string, unknown>).sort()
  } catch {
    return []
  }
}
