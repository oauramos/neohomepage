import { describe, expect, it } from 'vitest'
import type { Json, JsonObject } from '../json.ts'
import type { Node } from './node.ts'
import { runProjection } from './evaluate.ts'

const NOW = '2026-09-06T12:00:00.000Z'

function run(node: Node, source: Json = null, options: JsonObject = {}, targetBaseUrl?: string) {
  return runProjection(node, {
    source,
    options,
    now: NOW,
    ...(targetBaseUrl === undefined ? {} : { targetBaseUrl }),
  })
}

function value(node: Node, source: Json = null, options: JsonObject = {}): Json {
  const result = run(node, source, options)
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`)
  return result.value
}

const get = (path: string): Node => ({ op: 'get', path })
const lit = (v: unknown): Node => ({ op: 'const', value: v })

describe('paths', () => {
  const source = { records: [{ size: 10, series: { title: 'Andor' } }], total: 2 }

  it('reads the source root, nested keys and array indices', () => {
    expect(value(get('$'), source)).toEqual(source)
    expect(value(get('$.total'), source)).toBe(2)
    expect(value(get('$.records.0.series.title'), source)).toBe('Andor')
  })

  it('reads instance options through `opt`', () => {
    expect(value(get('opt.maxItems'), source, { maxItems: 5 })).toBe(5)
  })

  it('returns null for anything missing rather than throwing', () => {
    for (const path of ['$.nope', '$.records.99.size', '$.total.deeper', 'opt.absent', 'unbound.x']) {
      expect(value(get(path), source)).toBeNull()
    }
  })

  it('does not read inherited properties', () => {
    // A path must never reach Object.prototype: `$.constructor` would be both a leak and a value
    // the JSON contract cannot represent.
    expect(value(get('$.constructor'), source)).toBeNull()
    expect(value(get('$.toString'), source)).toBeNull()
  })
})

describe('totality', () => {
  const garbage: Json[] = [null, 'text', 42, true, {}, [], { a: 1 }]

  it('never throws, whatever the source shape', () => {
    const nodes: Node[] = [
      { op: 'count', of: get('$') },
      { op: 'sum', of: get('$'), path: 'x' },
      { op: 'avg', of: get('$') },
      { op: 'min', of: get('$') },
      { op: 'max', of: get('$') },
      { op: 'first', of: get('$') },
      { op: 'map', over: get('$'), as: 'e', body: get('e.x') },
      { op: 'filter', over: get('$'), as: 'e', where: get('e.x') },
      { op: 'sort', over: get('$'), by: [{ path: 'x' }] },
      { op: 'limit', over: get('$'), n: 3 },
      { op: 'distinctBy', over: get('$'), by: 'x' },
      { op: 'not', of: get('$') },
      { op: 'clamp', of: get('$'), min: 0, max: 1 },
      { op: 'format', of: get('$'), as: 'bytes' },
      { op: 'format', of: get('$'), as: 'relativeTime' },
      { op: 'arith', fn: 'div', of: [get('$'), lit(0)] },
    ]
    for (const node of nodes) {
      for (const source of garbage) {
        expect(() => run(node, source)).not.toThrow()
        expect(run(node, source).ok).toBe(true)
      }
    }
  })

  it('yields null for division by zero rather than Infinity', () => {
    expect(value({ op: 'arith', fn: 'div', of: [lit(1), lit(0)] })).toBeNull()
  })

  it('sums an empty set to 0 but averages it to null', () => {
    expect(value({ op: 'sum', of: lit([]) })).toBe(0)
    expect(value({ op: 'avg', of: lit([]) })).toBeNull()
  })
})

describe('structure operators', () => {
  it('maps and picks into an object shape', () => {
    const node: Node = {
      op: 'map',
      over: get('$.items'),
      as: 'e',
      body: { op: 'pick', fields: { title: get('e.name'), n: get('e.count') } },
    }
    expect(value(node, { items: [{ name: 'a', count: 1 }, { name: 'b', count: 2 }] })).toEqual([
      { title: 'a', n: 1 },
      { title: 'b', n: 2 },
    ])
  })

  it('sorts on multiple keys with independent directions', () => {
    // The sonarr queue case: downloading first, then by how much is left.
    const source = [
      { state: 'paused', left: 0.1 },
      { state: 'downloading', left: 0.9 },
      { state: 'downloading', left: 0.2 },
    ]
    const node: Node = {
      op: 'sort',
      over: get('$'),
      by: [
        { path: 'state', dir: 'desc', type: 'string' },
        { path: 'left', dir: 'asc', type: 'numeric' },
      ],
    }
    expect(value(node, source)).toEqual([
      { state: 'paused', left: 0.1 },
      { state: 'downloading', left: 0.2 },
      { state: 'downloading', left: 0.9 },
    ])
  })

  it('sorts missing keys last in both directions', () => {
    const source = [{ v: 2 }, {}, { v: 1 }]
    const asc = value({ op: 'sort', over: get('$'), by: [{ path: 'v', type: 'numeric' }] }, source)
    const desc = value(
      { op: 'sort', over: get('$'), by: [{ path: 'v', dir: 'desc', type: 'numeric' }] },
      source,
    )
    expect((asc as Json[]).at(-1)).toEqual({})
    expect((desc as Json[]).at(-1)).toEqual({})
  })

  it('sinks unorderable values last in both directions, like missing ones', () => {
    // "soon" is not a date. It is exactly as unknown as an absent field, and a descending sort
    // must not float it to the top — that was a real bug caught by the ascending/descending pair.
    const source = [{ d: '2026-01-10T00:00:00Z' }, { d: 'soon' }, { d: '2026-01-02T00:00:00Z' }]
    for (const dir of ['asc', 'desc'] as const) {
      const sorted = value(
        { op: 'sort', over: get('$'), by: [{ path: 'd', dir, type: 'date' }] },
        source,
      ) as Json[]
      expect(sorted.at(-1)).toEqual({ d: 'soon' })
    }
  })

  it('sorts dates chronologically, not lexicographically', () => {
    const source = [{ d: '2026-01-10T00:00:00Z' }, { d: '2026-01-02T00:00:00Z' }]
    expect(value({ op: 'sort', over: get('$'), by: [{ path: 'd', type: 'date' }] }, source)).toEqual([
      { d: '2026-01-02T00:00:00Z' },
      { d: '2026-01-10T00:00:00Z' },
    ])
  })

  it('joins two arrays by key without going quadratic', () => {
    const node: Node = {
      op: 'lookup',
      over: get('$.queue'),
      as: 'q',
      in: get('$.series'),
      onLeft: 'seriesId',
      onRight: 'id',
      bind: 's',
      body: { op: 'pick', fields: { show: get('s.title'), ep: get('q.title') } },
    }
    const source = {
      queue: [{ seriesId: 7, title: 'Ep 1' }, { seriesId: 99, title: 'Orphan' }],
      series: [{ id: 7, title: 'Andor' }],
    }
    expect(value(node, source)).toEqual([
      { show: 'Andor', ep: 'Ep 1' },
      { show: null, ep: 'Orphan' },
    ])
  })

  it('deduplicates on a key, keeping the first occurrence', () => {
    const source = [{ k: 'a', n: 1 }, { k: 'b', n: 2 }, { k: 'a', n: 3 }]
    expect(value({ op: 'distinctBy', over: get('$'), by: 'k' }, source)).toEqual([
      { k: 'a', n: 1 },
      { k: 'b', n: 2 },
    ])
  })

  it('concatenates arrays and skips nulls, which is how multi-source merging works', () => {
    const node: Node = { op: 'concat', of: [get('$.a'), get('$.b'), get('$.missing')] }
    expect(value(node, { a: [1, 2], b: [3] })).toEqual([1, 2, 3])
  })
})

describe('comparison', () => {
  it('orders numbers and strings but refuses mixed types instead of coercing', () => {
    expect(value({ op: 'compare', cmp: 'lt', left: lit(1), right: lit(2) })).toBe(true)
    expect(value({ op: 'compare', cmp: 'gt', left: lit('b'), right: lit('a') })).toBe(true)
    // JavaScript says null >= 0 is true and [] < 1 is true. Both are false here.
    expect(value({ op: 'compare', cmp: 'gte', left: lit(null), right: lit(0) })).toBe(false)
    expect(value({ op: 'compare', cmp: 'lt', left: lit([]), right: lit(1) })).toBe(false)
  })

  it('compares objects and arrays structurally for equality', () => {
    expect(value({ op: 'compare', cmp: 'eq', left: lit({ a: 1 }), right: lit({ a: 1 }) })).toBe(true)
    expect(value({ op: 'compare', cmp: 'ne', left: lit([1]), right: lit([2]) })).toBe(true)
  })
})

describe('mapValue', () => {
  const node: Node = {
    op: 'mapValue',
    of: get('$.state'),
    cases: { importBlocked: 'import blocked', downloading: 'downloading' },
    fallback: 'unknown',
  }

  it('remaps a closed set of upstream strings', () => {
    expect(value(node, { state: 'importBlocked' })).toBe('import blocked')
  })

  it('falls back for anything unlisted, including a missing value', () => {
    expect(value(node, { state: 'weird' })).toBe('unknown')
    expect(value(node, {})).toBe('unknown')
  })

  it('cannot be tricked into reading a prototype key', () => {
    const hostile: Node = { op: 'mapValue', of: lit('toString'), cases: { a: 1 }, fallback: 'safe' }
    expect(value(hostile)).toBe('safe')
  })
})

describe('targetUrl', () => {
  const node: Node = { op: 'targetUrl', path: get('$.p') }

  it('joins a path suffix onto the bound target, never a host from the manifest', () => {
    const result = run(node, { p: '/series/andor' }, {}, 'http://10.0.0.20:8989/')
    expect(result.ok && result.value).toBe('http://10.0.0.20:8989/series/andor')
  })

  it('refuses traversal and protocol-relative escapes', () => {
    for (const p of ['/../admin', '//evil.example.com/x', '/a/../../b']) {
      const result = run(node, { p }, {}, 'http://10.0.0.20:8989')
      expect(result.ok && result.value).toBeNull()
    }
  })

  it('yields null when no target is bound', () => {
    expect(value(node, { p: '/x' })).toBeNull()
  })
})

describe('formatting', () => {
  it('renders absolute units deterministically', () => {
    expect(value({ op: 'format', of: lit(1536), as: 'bytes' })).toBe('1.5 KiB')
    expect(value({ op: 'format', of: lit(1_500_000), as: 'bitrate' })).toBe('1.5 Mbps')
    expect(value({ op: 'format', of: lit(3725), as: 'duration' })).toBe('1h 2m')
    expect(value({ op: 'format', of: lit(0.42), as: 'percent' })).toBe('42%')
    expect(value({ op: 'format', of: lit(0), as: 'duration' })).toBe('0s')
  })

  it('carries the raw instant alongside relative time, so a static page can rehydrate', () => {
    const rendered = value({ op: 'format', of: lit('2026-09-06T11:30:00.000Z'), as: 'relativeTime' })
    expect(rendered).toEqual({ v: '30 minutes ago', iso: '2026-09-06T11:30:00.000Z', rel: true })
  })

  it('uses the injected clock, never the real one', () => {
    const node: Node = { op: 'format', of: { op: 'now' }, as: 'relativeTime' }
    const first = runProjection(node, { source: null, options: {}, now: NOW })
    const second = runProjection(node, { source: null, options: {}, now: NOW })
    expect(first).toEqual(second)
    expect(first.ok && (first.value as { iso: string }).iso).toBe(NOW)
  })
})

describe('limits', () => {
  it('stops a projection that exhausts its fuel', () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ i }))
    const node: Node = { op: 'map', over: get('$'), as: 'e', body: get('e.i') }
    const result = runProjection(node, { source: big, options: {}, now: NOW, limits: { fuel: 50 } })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/evaluation budget/)
  })

  it('truncates an oversized array before any loop sees it', () => {
    const big = Array.from({ length: 100 }, (_, i) => i)
    const result = runProjection(
      { op: 'count', of: get('$') },
      { source: big, options: {}, now: NOW, limits: { maxArray: 10 } },
    )
    expect(result.ok && result.value).toBe(10)
  })

  it('refuses to return a projection larger than the output cap', () => {
    const result = runProjection(
      { op: 'const', value: 'x'.repeat(5000) },
      { source: null, options: {}, now: NOW, limits: { maxOutputBytes: 1000 } },
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/byte cap/)
  })
})
