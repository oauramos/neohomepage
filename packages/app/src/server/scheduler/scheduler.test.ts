import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKOFF, nextIntervalMs, withJitter } from './backoff.ts'
import { TimerHeap } from './heap.ts'
import { canonicalJson, fetchKey } from './key.ts'

describe('TimerHeap', () => {
  const heap = () => new TimerHeap<string>()

  it('drains in due order, not insertion order', () => {
    const h = heap()
    h.schedule({ id: 'c', dueAt: 300, value: 'c' })
    h.schedule({ id: 'a', dueAt: 100, value: 'a' })
    h.schedule({ id: 'b', dueAt: 200, value: 'b' })
    expect(h.drain(1000).map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(h.size).toBe(0)
  })

  it('drains only what is due, and leaves the rest', () => {
    const h = heap()
    h.schedule({ id: 'a', dueAt: 100, value: 'a' })
    h.schedule({ id: 'b', dueAt: 500, value: 'b' })
    expect(h.drain(200).map((e) => e.id)).toEqual(['a'])
    expect(h.size).toBe(1)
    expect(h.peek()?.id).toBe('b')
  })

  it('reschedules an existing id instead of duplicating it', () => {
    // A widget whose interval changes must not end up scheduled twice, which would double its
    // request rate silently.
    const h = heap()
    h.schedule({ id: 'a', dueAt: 500, value: 'a' })
    h.schedule({ id: 'a', dueAt: 100, value: 'a' })
    expect(h.size).toBe(1)
    expect(h.peek()?.dueAt).toBe(100)
  })

  it('reschedules later as well as earlier', () => {
    const h = heap()
    h.schedule({ id: 'a', dueAt: 100, value: 'a' })
    h.schedule({ id: 'b', dueAt: 200, value: 'b' })
    h.schedule({ id: 'a', dueAt: 900, value: 'a' })
    expect(h.peek()?.id).toBe('b')
    expect(h.drain(1000).map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('cancels from anywhere in the heap without corrupting order', () => {
    const h = heap()
    for (let i = 0; i < 32; i++) h.schedule({ id: `k${i}`, dueAt: (i * 37) % 100, value: `k${i}` })
    expect(h.cancel('k17')).toBe(true)
    expect(h.cancel('k17')).toBe(false)
    expect(h.has('k17')).toBe(false)

    const drained = h.drain(Number.MAX_SAFE_INTEGER)
    expect(drained).toHaveLength(31)
    const times = drained.map((e) => e.dueAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('stays ordered under a randomised workload', () => {
    // The heap decides when every upstream request happens; an ordering bug here shows up as
    // "some widgets just stop updating", which is close to unreportable.
    const h = heap()
    let seed = 42
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

    for (let i = 0; i < 500; i++)
      h.schedule({ id: `k${i}`, dueAt: Math.floor(random() * 10_000), value: '' })
    for (let i = 0; i < 200; i++)
      h.schedule({ id: `k${i}`, dueAt: Math.floor(random() * 10_000), value: '' })
    for (let i = 0; i < 100; i++) h.cancel(`k${Math.floor(random() * 500)}`)

    const drained = h.drain(Number.MAX_SAFE_INTEGER)
    const times = drained.map((e) => e.dueAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(drained.map((e) => e.id)).size).toBe(drained.length)
  })
})

describe('fetch keys', () => {
  const base = {
    targetId: 'tSonarr',
    targetRevision: 'r1',
    operation: 'queue',
    params: { pageSize: 5, includeSeries: true },
  }

  it('collapses two widgets asking for the same thing into one fetch', () => {
    // This is what makes "three Radarr sources, one HTTP request" fall out for free, with no
    // special case anywhere in the calendar widget.
    expect(fetchKey(base)).toBe(fetchKey({ ...base, params: { includeSeries: true, pageSize: 5 } }))
  })

  it('separates different parameters', () => {
    expect(fetchKey(base)).not.toBe(fetchKey({ ...base, params: { pageSize: 10 } }))
  })

  it('separates different operations and targets', () => {
    expect(fetchKey(base)).not.toBe(fetchKey({ ...base, operation: 'health' }))
    expect(fetchKey(base)).not.toBe(fetchKey({ ...base, targetId: 'tRadarr' }))
  })

  it('changes when the target changes, so nothing stale survives a repoint', () => {
    // Otherwise a cached projection stays attributed to a service the user has since moved.
    expect(fetchKey(base)).not.toBe(fetchKey({ ...base, targetRevision: 'r2' }))
  })

  it('canonicalises nested objects and ignores undefined', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: undefined })).toBe('{"b":{"c":2,"d":1}}')
    expect(canonicalJson([3, { b: 1, a: 2 }])).toBe('[3,{"a":2,"b":1}]')
  })
})

describe('backoff', () => {
  const input = {
    baseIntervalMs: 60_000,
    consecutiveFailures: 0,
    subscribers: 1,
    unobservedForMs: 0,
  }

  it('leaves a healthy target at its configured interval', () => {
    expect(nextIntervalMs(input)).toBe(60_000)
  })

  it('tolerates a couple of failures before stretching', () => {
    expect(nextIntervalMs({ ...input, consecutiveFailures: 1 })).toBe(60_000)
    expect(nextIntervalMs({ ...input, consecutiveFailures: 2 })).toBe(60_000)
    expect(nextIntervalMs({ ...input, consecutiveFailures: 3 })).toBe(300_000)
    expect(nextIntervalMs({ ...input, consecutiveFailures: 4 })).toBe(900_000)
  })

  it('caps the stretch so a dead target is still retried eventually', () => {
    expect(nextIntervalMs({ ...input, consecutiveFailures: 50 })).toBe(
      DEFAULT_BACKOFF.maxIntervalMs,
    )
  })

  it('decays to the idle interval when nobody has been watching', () => {
    // The largest single saving in the design: a home dashboard is unobserved most of the day.
    expect(nextIntervalMs({ ...input, subscribers: 0, unobservedForMs: 6 * 60_000 })).toBe(600_000)
  })

  it('does not decay while someone is watching', () => {
    expect(nextIntervalMs({ ...input, subscribers: 1, unobservedForMs: 60 * 60_000 })).toBe(60_000)
  })

  it('does not decay before the idle threshold', () => {
    expect(nextIntervalMs({ ...input, subscribers: 0, unobservedForMs: 60_000 })).toBe(60_000)
  })

  it('never speeds a failing target up just because it went idle', () => {
    const failing = {
      ...input,
      consecutiveFailures: 50,
      subscribers: 0,
      unobservedForMs: 60 * 60_000,
    }
    expect(nextIntervalMs(failing)).toBe(DEFAULT_BACKOFF.maxIntervalMs)
  })
})

describe('jitter', () => {
  it('stays within a tenth either way', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const value = withJitter(60_000, () => r)
      expect(value).toBeGreaterThanOrEqual(54_000)
      expect(value).toBeLessThanOrEqual(66_000)
    }
  })

  it('spreads a fleet that would otherwise fire as one burst', () => {
    // Forty widgets at the same interval align permanently after the first tick without this.
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const values = new Set(Array.from({ length: 40 }, () => withJitter(60_000, random)))
    expect(values.size).toBeGreaterThan(20)
  })

  it('never returns zero or a negative delay', () => {
    expect(withJitter(1, () => 0)).toBeGreaterThan(0)
  })
})
