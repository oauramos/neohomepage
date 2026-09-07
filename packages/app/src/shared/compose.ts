import type { Compose, Projection } from '@neohomepage/catalog-schema'

/**
 * Merge N source streams into one widget.
 *
 * Deliberately not the DSL. The DSL runs *inside* a source, on that upstream's own response; the
 * merge runs across sources and needs nothing more than concat, distinct, sort and limit. Giving
 * it an expression language would double the surface a hostile manifest can reach for no widget
 * that anyone has actually asked for.
 *
 * The interesting behaviour is `partial`. A home calendar binds four services and one of them is
 * always down; blanking the tile because Radarr is restarting is the failure people leave a
 * dashboard over. With `partial`, the surviving sources render and the widget reports `degraded`.
 */

export type SourcePart = {
  /** For diagnostics only — never rendered, so it can name a target the viewer cannot reach. */
  readonly key: string
  /**
   * Bound but never fetched yet: counted in the total, counted as neither success nor failure.
   *
   * Without the distinction, every composite spends its first seconds after a restart reporting
   * "degraded" and showing a partial list, which is indistinguishable from a service actually
   * being down and trains people to ignore the badge.
   */
  readonly pending: boolean
  readonly ok: boolean
  readonly items: readonly Item[]
  readonly fetchedAt: string | null
  readonly ageMs: number
  readonly state: 'fresh' | 'stale' | 'error'
  readonly errorCode: string | null
}

type Item = NonNullable<Projection['items']>[number]

export type ComposedWidget = {
  readonly projection: Projection | null
  readonly meta: {
    readonly fetchedAt: string
    readonly ageMs: number
    readonly state: 'fresh' | 'stale' | 'error'
    readonly errorCode?: string
  }
  /** How many of the bound sources answered, so the tile can say "3 of 4". */
  readonly sources: { readonly total: number; readonly ok: number }
}

/** Read a dotted path off an item. Total: a missing or non-object step yields undefined. */
function at(item: Item, path: string): unknown {
  let cursor: unknown = item
  for (const step of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[step]
  }
  return cursor
}

/**
 * Order two items by one sort key, with the direction applied where it belongs.
 *
 * The missing-value bucket is decided BEFORE the flip and never flipped. Applying `desc` to the
 * comparator's whole result — the obvious one-liner — floats every item that has no value at the
 * key to the TOP under `desc`, so a calendar sorted newest-first leads with its junk rows. The
 * same mistake was already found once in the DSL's own sort; it is easy to make twice.
 */
function compareByKey(a: Item, b: Item, path: string, direction: 'asc' | 'desc'): number {
  const left = at(a, path)
  const right = at(b, path)
  const leftMissing = left === undefined || left === null
  const rightMissing = right === undefined || right === null
  if (leftMissing && rightMissing) return 0
  if (leftMissing) return 1
  if (rightMissing) return -1

  const ordered =
    typeof left === 'number' && typeof right === 'number'
      ? left < right
        ? -1
        : left > right
          ? 1
          : 0
      : String(left).localeCompare(String(right), 'en-US')
  return direction === 'desc' ? -ordered : ordered
}

export function composeSources(compose: Compose, parts: readonly SourcePart[]): ComposedWidget {
  const answered = parts.filter((part) => part.ok)
  const failed = parts.filter((part) => !part.ok && !part.pending).length

  if (answered.length === 0) {
    const firstError = parts.find((part) => part.errorCode !== null)?.errorCode
    return {
      projection: null,
      meta: {
        fetchedAt: newest(parts) ?? '',
        ageMs: parts.length === 0 ? 0 : Math.min(...parts.map((part) => part.ageMs)),
        state: 'error',
        errorCode:
          firstError ??
          (parts.length === 0
            ? 'no-sources'
            : // Every bound source is still on its first fetch. Reported distinctly so the tile
              // says "loading" rather than accusing four healthy services of being down.
              failed === 0
              ? 'pending'
              : 'all-sources-failed'),
      },
      sources: { total: parts.length, ok: 0 },
    }
  }

  // Refusing to render when any source failed is what `partial: false` buys: a widget whose whole
  // point is completeness (a duty roster, say) is better blank than quietly missing a shift.
  if (failed > 0 && !compose.partial) {
    const firstError = parts.find((part) => !part.ok)?.errorCode
    return {
      projection: null,
      meta: {
        fetchedAt: newest(parts) ?? '',
        ageMs: Math.min(...parts.map((part) => part.ageMs)),
        state: 'error',
        errorCode: firstError ?? 'source-failed',
      },
      sources: { total: parts.length, ok: answered.length },
    }
  }

  let items: Item[] = answered.flatMap((part) => [...part.items])

  const distinctBy = compose.distinctBy
  if (distinctBy !== undefined) {
    const seen = new Set<string>()
    const distinct: Item[] = []
    for (const item of items) {
      const parts = distinctBy.map((path) => at(item, path))
      // An item missing ANY key is never a duplicate: two rows the upstream left sparse are not
      // the same event, and collapsing them silently deletes data whose only fault is a thin
      // response. Two episodes of one series differ only by their instant, so a single key is
      // almost always the wrong granularity — which is why this takes a list.
      if (parts.some((value) => value === undefined || value === null)) {
        distinct.push(item)
        continue
      }
      const stamp = parts.map((value) => `${typeof value}:${String(value)}`).join('\u0000')
      if (seen.has(stamp)) continue
      seen.add(stamp)
      distinct.push(item)
    }
    items = distinct
  }

  if (compose.sortBy.length > 0) {
    items = [...items].sort((a, b) => {
      for (const key of compose.sortBy) {
        const ordered = compareByKey(a, b, key.path, key.direction)
        if (ordered !== 0) return ordered
      }
      return 0
    })
  }

  const limited = items.slice(0, compose.limit)
  const stale = answered.some((part) => part.state === 'stale')

  return {
    projection: {
      items: limited,
      status: failed > 0 ? 'degraded' : 'ok',
    },
    meta: {
      fetchedAt: newest(answered) ?? '',
      // The oldest answering source, not the newest: a widget is only as fresh as its stalest part.
      ageMs: Math.max(...answered.map((part) => part.ageMs)),
      state: stale ? 'stale' : 'fresh',
      ...(failed > 0 ? { errorCode: 'partial' } : {}),
    },
    sources: { total: parts.length, ok: answered.length },
  }
}

function newest(parts: readonly SourcePart[]): string | null {
  let latest: string | null = null
  for (const part of parts) {
    if (part.fetchedAt === null) continue
    if (latest === null || part.fetchedAt > latest) latest = part.fetchedAt
  }
  return latest
}
