import type { Compose, Projection, ProjectionEnvelope } from '@neohomepage/catalog-schema'

/**
 * Merges N source streams into one widget with concat, distinct, sort and limit only. Deliberately
 * not the DSL, which runs inside one source; an expression language here would widen the surface
 * a hostile manifest can reach.
 */

export type SourcePart = {
  /** For diagnostics only — never rendered, so it can name a target the viewer cannot reach. */
  readonly key: string
  /** Bound but not fetched yet: counted in the total, as neither success nor failure. */
  readonly pending: boolean
  readonly ok: boolean
  readonly items: readonly Item[]
  readonly fetchedAt: string | null
  readonly ageMs: number
  readonly state: 'fresh' | 'stale' | 'error'
  readonly errorCode: string | null
}

type Item = NonNullable<Projection['items']>[number]

export type ComposedWidget = ProjectionEnvelope & {
  /** How many of the bound sources answered, so the tile can say "3 of 4". */
  readonly sources: { readonly total: number; readonly ok: number }
}

function at(item: Item, path: string): unknown {
  let cursor: unknown = item
  for (const step of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[step]
  }
  return cursor
}

// Missing values sort last in both directions: the direction flip is applied only to the
// compared values, never to the missing-value bucket.
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
          (parts.length === 0 ? 'no-sources' : failed === 0 ? 'pending' : 'all-sources-failed'),
      },
      sources: { total: parts.length, ok: 0 },
    }
  }

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
      // An item missing any key is never a duplicate: sparse upstream rows are not the same event.
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
