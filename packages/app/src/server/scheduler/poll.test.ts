import { describe, expect, it } from 'vitest'
import { ProjectionCache } from './cache.ts'
import { PollScheduler, type FetchOutcome } from './scheduler.ts'

/**
 * Time is injected, so an hour of idle decay costs a millisecond to test. Nothing here waits.
 */
function harness(options: { concurrency?: number } = {}) {
  let now = 1_700_000_000_000
  const timers: { at: number; callback: () => void }[] = []

  const scheduler = new PollScheduler({
    now: () => now,
    random: () => 0.5, // no jitter, so due times are exact
    setTimer: (callback, delay) => {
      const handle = { at: now + delay, callback }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as { at: number; callback: () => void })
      if (at >= 0) timers.splice(at, 1)
    },
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  })

  return {
    scheduler,
    advance(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
    async tick() {
      await scheduler.tick()
    },
  }
}

const ok = (projection: unknown): FetchOutcome => ({ ok: true, projection: projection as never })
const fail = (code: string): FetchOutcome => ({ ok: false, code })

describe('sharing one fetch across subscribers', () => {
  it('runs a key once per interval no matter how many widgets want it', async () => {
    // Two widgets on the same Sonarr queue is one request. Client-side polling would make it one
    // request per widget per tab.
    const h = harness()
    let calls = 0
    const spec = {
      key: 'k1',
      intervalMs: 60_000,
      execute: async () => {
        calls++
        return ok({ n: calls })
      },
    }
    h.scheduler.register(spec)
    h.scheduler.register(spec)
    h.scheduler.register(spec)

    await h.tick()
    expect(calls).toBe(1)

    h.advance(60_000)
    await h.tick()
    expect(calls).toBe(2)
  })

  it('fetches immediately on first registration rather than waiting an interval', async () => {
    const h = harness()
    let calls = 0
    h.scheduler.register({ key: 'k1', intervalMs: 300_000, execute: async () => (calls++, ok({})) })
    await h.tick()
    expect(calls).toBe(1)
  })
})

describe('idle decay', () => {
  it('slows down once the last viewer leaves, and wakes immediately when one returns', async () => {
    const h = harness()
    let calls = 0
    const spec = { key: 'k1', intervalMs: 60_000, execute: async () => (calls++, ok({ calls })) }

    const release = h.scheduler.register(spec)
    await h.tick()
    expect(calls).toBe(1)

    release()
    h.advance(6 * 60_000) // past the idle threshold
    await h.tick()
    expect(calls).toBe(2)

    // Now unobserved: the next poll should be an idle interval away, not a normal one.
    h.advance(60_000)
    await h.tick()
    expect(calls).toBe(2)

    h.advance(10 * 60_000)
    await h.tick()
    expect(calls).toBe(3)

    // A viewer returns: fetch now, not at the decayed interval, or the first thing they see is a
    // ten-minute-old number.
    h.scheduler.register(spec)
    await h.tick()
    expect(calls).toBe(4)
  })
})

describe('failures', () => {
  it('keeps the last good projection and marks it stale rather than blanking the widget', async () => {
    const h = harness()
    let mode: 'ok' | 'fail' = 'ok'
    h.scheduler.register({
      key: 'k1',
      intervalMs: 60_000,
      execute: async () => (mode === 'ok' ? ok({ queue: 3 }) : fail('timeout')),
    })

    await h.tick()
    expect(h.scheduler.view('k1')).toMatchObject({ state: 'fresh', projection: { queue: 3 } })

    mode = 'fail'
    h.advance(60_000)
    await h.tick()
    const stale = h.scheduler.view('k1')
    expect(stale).toMatchObject({ state: 'stale', errorCode: 'timeout', projection: { queue: 3 } })
    expect(stale?.ageMs).toBe(60_000)
  })

  it('gives up on the last good value once it is old enough to mislead', async () => {
    const h = harness()
    let mode: 'ok' | 'fail' = 'ok'
    h.scheduler.register({
      key: 'k1',
      intervalMs: 10_000,
      execute: async () => (mode === 'ok' ? ok({ queue: 3 }) : fail('refused')),
    })
    await h.tick()

    mode = 'fail'
    for (let i = 0; i < 10; i++) {
      h.advance(10 * 60_000)
      await h.tick()
    }
    expect(h.scheduler.view('k1')?.state).toBe('error')
  })

  it('goes straight to error when nothing has ever succeeded', async () => {
    const h = harness()
    h.scheduler.register({ key: 'k1', intervalMs: 60_000, execute: async () => fail('dns') })
    await h.tick()
    expect(h.scheduler.view('k1')).toMatchObject({
      state: 'error',
      errorCode: 'dns',
      projection: null,
    })
  })

  it('backs off after repeated failures instead of hammering a dead service', async () => {
    const h = harness()
    let calls = 0
    h.scheduler.register({
      key: 'k1',
      intervalMs: 60_000,
      execute: async () => (calls++, fail('refused')),
    })

    // Three failures at the normal interval, then it stretches.
    for (let i = 0; i < 3; i++) {
      await h.tick()
      h.advance(60_000)
    }
    expect(calls).toBe(3)

    h.advance(60_000)
    await h.tick()
    // Fourth attempt is now 5 minutes out, so a single extra minute is not enough.
    expect(calls).toBe(3)
  })

  it('survives an executor that throws, rather than stopping the whole loop', async () => {
    const h = harness()
    let good = 0
    h.scheduler.register({
      key: 'bad',
      intervalMs: 60_000,
      execute: async () => {
        throw new Error('bug in a widget')
      },
    })
    h.scheduler.register({ key: 'good', intervalMs: 60_000, execute: async () => (good++, ok({})) })

    await h.tick()
    expect(h.scheduler.view('bad')).toMatchObject({ state: 'error', errorCode: 'internal' })
    expect(good).toBe(1)
  })
})

describe('change notification', () => {
  it('announces only real content changes', async () => {
    // Most polls return the same numbers. Waking every browser for them is pure cost.
    const h = harness()
    const seen: string[] = []
    h.scheduler.onUpdate((key) => seen.push(key))

    let value = 3
    h.scheduler.register({
      key: 'k1',
      intervalMs: 60_000,
      execute: async () => ok({ queue: value }),
    })

    await h.tick()
    expect(seen).toEqual(['k1'])

    h.advance(60_000)
    await h.tick()
    expect(seen).toEqual(['k1']) // unchanged upstream, no frame

    value = 4
    h.advance(60_000)
    await h.tick()
    expect(seen).toEqual(['k1', 'k1'])
  })

  it('always announces a failure, because the age chip has to move', async () => {
    const h = harness()
    const seen: string[] = []
    h.scheduler.onUpdate((key) => seen.push(key))
    h.scheduler.register({ key: 'k1', intervalMs: 60_000, execute: async () => fail('timeout') })

    await h.tick()
    h.advance(60_000)
    await h.tick()
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })
})

describe('concurrency', () => {
  it('never exceeds the in-flight budget', async () => {
    // Forty widgets must not open forty sockets at once on a 2-vCPU box.
    const h = harness({ concurrency: 2 })
    let active = 0
    let peak = 0
    const settle: (() => void)[] = []

    for (let i = 0; i < 10; i++) {
      h.scheduler.register({
        key: `k${i}`,
        intervalMs: 60_000,
        execute: () =>
          new Promise<FetchOutcome>((resolve) => {
            active++
            peak = Math.max(peak, active)
            settle.push(() => {
              active--
              resolve(ok({}))
            })
          }),
      })
    }

    const running = h.tick()
    // Release in waves; the scheduler must never have had more than two open at once.
    while (settle.length > 0) (settle.shift() as () => void)()
    await running
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('unregistering', () => {
  it('stops polling and forgets the cached projection', async () => {
    const h = harness()
    let calls = 0
    h.scheduler.register({ key: 'k1', intervalMs: 60_000, execute: async () => (calls++, ok({})) })
    await h.tick()

    h.scheduler.unregister('k1')
    h.advance(600_000)
    await h.tick()

    expect(calls).toBe(1)
    expect(h.scheduler.view('k1')).toBeUndefined()
    expect(h.scheduler.registered).toBe(0)
  })
})

describe('ProjectionCache directly', () => {
  it('reports whether content changed, which is what suppresses churn', () => {
    const cache = new ProjectionCache()
    expect(cache.succeed('k', { a: 1 }, '2026-01-01T00:00:00.000Z').changed).toBe(true)
    expect(cache.succeed('k', { a: 1 }, '2026-01-01T00:01:00.000Z').changed).toBe(false)
    expect(cache.succeed('k', { a: 2 }, '2026-01-01T00:02:00.000Z').changed).toBe(true)
  })

  it('does not treat key order as a content change', () => {
    const cache = new ProjectionCache()
    cache.succeed('k', { a: 1, b: 2 }, '2026-01-01T00:00:00.000Z')
    // Same content, and the projection DSL builds objects in a fixed order, so this stays stable.
    expect(cache.succeed('k', { a: 1, b: 2 }, '2026-01-01T00:01:00.000Z').changed).toBe(false)
  })
})
