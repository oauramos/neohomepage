import { createHash } from 'node:crypto'
import type { Json } from '@neohomepage/catalog-schema'

/**
 * The projection cache.
 *
 * Only projections live here, never raw upstream bodies. That single rule is what makes a
 * hypothetical SSRF to qBittorrent's `app/preferences` return `{}` instead of an SMTP password,
 * and it shrinks both the cache and every SSE frame by an order of magnitude: sixty cached entries
 * cost a couple of megabytes rather than tens.
 *
 * A failure never erases the last good value. A widget showing yesterday's number with a visible
 * age is useful; a widget that blanks the moment a service restarts is not.
 */

export type EntryState = 'fresh' | 'stale' | 'error'

export type CacheEntry = {
  readonly key: string
  /** The last projection that succeeded, kept across failures. */
  readonly projection: Json | null
  readonly fetchedAt: string | null
  readonly state: EntryState
  /** A stable code. Never a URL, never an upstream message. */
  readonly errorCode: string | null
  readonly consecutiveFailures: number
  /** Hash of the projection, so an unchanged upstream produces no churn at all. */
  readonly contentHash: string | null
}

export type CacheView = CacheEntry & { readonly ageMs: number }

function hash(value: Json): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex')
    .slice(0, 16)
}

export type CacheOptions = {
  /** How long a last-good value stays "stale" before it is presented as an error. */
  readonly staleAfterMs?: number
}

export class ProjectionCache {
  #entries = new Map<string, CacheEntry>()
  #staleMultiplier = 6
  readonly #options: CacheOptions

  constructor(options: CacheOptions = {}) {
    this.#options = options
  }

  get size(): number {
    return this.#entries.size
  }

  keys(): string[] {
    return [...this.#entries.keys()]
  }

  raw(key: string): CacheEntry | undefined {
    return this.#entries.get(key)
  }

  /** The entry as a caller should see it, with its age computed against `now`. */
  view(key: string, now: number): CacheView | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    const ageMs = entry.fetchedAt === null ? 0 : Math.max(0, now - Date.parse(entry.fetchedAt))
    return { ...entry, ageMs }
  }

  /**
   * Record a success.
   *
   * Returns whether the content actually changed. An upstream that answers with the same numbers
   * produces no projection churn, no SSE frame and no republish — which is most polls, most of
   * the time.
   */
  succeed(key: string, projection: Json, at: string): { changed: boolean } {
    const previous = this.#entries.get(key)
    const contentHash = hash(projection)
    const changed = previous?.contentHash !== contentHash

    this.#entries.set(key, {
      key,
      projection,
      fetchedAt: at,
      state: 'fresh',
      errorCode: null,
      consecutiveFailures: 0,
      contentHash,
    })
    return { changed }
  }

  /**
   * Record a failure without discarding the last good value.
   *
   * The entry becomes `stale` while that value is still worth showing, and only `error` once it is
   * old enough to mislead. A widget that has never succeeded goes straight to `error`, because
   * there is nothing to be stale about.
   */
  fail(key: string, errorCode: string, at: string, intervalMs: number): void {
    const previous = this.#entries.get(key)
    const failures = (previous?.consecutiveFailures ?? 0) + 1
    const staleWindow = this.#options.staleAfterMs ?? intervalMs * this.#staleMultiplier
    const lastSuccess =
      previous?.fetchedAt === null || previous?.fetchedAt === undefined
        ? null
        : Date.parse(previous.fetchedAt)
    const stillUseful =
      lastSuccess !== null &&
      Date.parse(at) - lastSuccess < staleWindow &&
      previous?.projection != null

    this.#entries.set(key, {
      key,
      projection: previous?.projection ?? null,
      fetchedAt: previous?.fetchedAt ?? null,
      state: stillUseful ? 'stale' : 'error',
      errorCode,
      consecutiveFailures: failures,
      contentHash: previous?.contentHash ?? null,
    })
  }

  delete(key: string): boolean {
    return this.#entries.delete(key)
  }

  /** Drop everything, used when the config revision changes wholesale. */
  clear(): void {
    this.#entries.clear()
  }
}
