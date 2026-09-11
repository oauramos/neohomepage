import { createHash } from 'node:crypto'
import type { Json } from '@neohomepage/catalog-schema'

/**
 * Projection cache. Holds projections only, never raw upstream bodies, so a cached entry cannot
 * leak an upstream secret; a failure keeps the last good projection.
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

const STALE_MULTIPLIER = 6

export class ProjectionCache {
  #entries = new Map<string, CacheEntry>()

  raw(key: string): CacheEntry | undefined {
    return this.#entries.get(key)
  }

  view(key: string, now: number): CacheView | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    const ageMs = entry.fetchedAt === null ? 0 : Math.max(0, now - Date.parse(entry.fetchedAt))
    return { ...entry, ageMs }
  }

  /** Returns whether the projection changed, so an identical upstream answer produces no churn. */
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
   * Keeps the last good projection: `stale` while it is within the stale window, `error` once it
   * is older or there never was one.
   */
  fail(key: string, errorCode: string, at: string, intervalMs: number): void {
    const previous = this.#entries.get(key)
    const failures = (previous?.consecutiveFailures ?? 0) + 1
    const staleWindow = intervalMs * STALE_MULTIPLIER
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
}
