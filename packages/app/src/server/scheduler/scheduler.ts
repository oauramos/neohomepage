import type { Json } from '@neohomepage/catalog-schema'
import { DEFAULT_BACKOFF, nextIntervalMs, withJitter, type BackoffPolicy } from './backoff.ts'
import { ProjectionCache, type CacheView } from './cache.ts'
import { TimerHeap } from './heap.ts'

/**
 * The poll scheduler.
 *
 * One heap, one timer, one in-flight budget, shared by every browser tab. The alternative —
 * letting each open tab poll for itself — costs roughly five times as much for a household with
 * a phone, a desktop and a wall tablet all showing the same board, and it multiplies load on the
 * very services being displayed.
 *
 * Everything time- and IO-shaped is injected: the clock, the randomness, the timer and the
 * executor. That is what makes the whole loop testable without waiting for real seconds, and the
 * tests exercise idle decay over simulated hours.
 */

export type FetchOutcome =
  { readonly ok: true; readonly projection: Json } | { readonly ok: false; readonly code: string }

export type FetchSpec = {
  readonly key: string
  /** From the manifest, already clamped by the target's minimum. */
  readonly intervalMs: number
  readonly execute: () => Promise<FetchOutcome>
}

export type SchedulerDeps = {
  readonly now: () => number
  readonly random?: () => number
  readonly setTimer: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  readonly policy?: BackoffPolicy
  /** Simultaneous upstream requests. Forty widgets must not open forty sockets on a 2-vCPU box. */
  readonly concurrency?: number
}

export type UpdateListener = (key: string, entry: CacheView) => void

type Registration = {
  spec: FetchSpec
  subscribers: number
  /** When the last subscriber left, for idle decay. */
  unobservedSince: number | null
  inFlight: boolean
}

export class PollScheduler {
  readonly cache = new ProjectionCache()

  #heap = new TimerHeap<string>()
  #registrations = new Map<string, Registration>()
  #listeners = new Set<UpdateListener>()
  #timer: unknown = null
  #running = false
  #active = 0
  #queue: string[] = []

  readonly #deps: Required<Omit<SchedulerDeps, 'policy'>> & { policy: BackoffPolicy }

  constructor(deps: SchedulerDeps) {
    this.#deps = {
      now: deps.now,
      random: deps.random ?? Math.random,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      concurrency: deps.concurrency ?? 4,
      policy: deps.policy ?? DEFAULT_BACKOFF,
    }
  }

  onUpdate(listener: UpdateListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get registered(): number {
    return this.#registrations.size
  }

  /**
   * Register a fetch, or add a subscriber to one that already exists.
   *
   * Returns an unsubscribe function rather than exposing a decrement, so a caller cannot
   * accidentally release someone else's reference.
   */
  register(spec: FetchSpec, options: { readonly observed?: boolean } = {}): () => void {
    const observed = options.observed ?? true
    const existing = this.#registrations.get(spec.key)

    if (existing === undefined) {
      this.#registrations.set(spec.key, {
        spec,
        subscribers: observed ? 1 : 0,
        unobservedSince: observed ? null : this.#deps.now(),
        inFlight: false,
      })
      // First registration runs immediately: a page that has just opened should not wait a full
      // interval to show anything.
      this.#heap.schedule({ id: spec.key, dueAt: this.#deps.now(), value: spec.key })
    } else {
      existing.spec = spec
      if (observed) {
        const wasIdle = existing.subscribers === 0
        existing.subscribers++
        existing.unobservedSince = null
        // Waking from idle: fetch now rather than at the decayed interval, or the first thing a
        // returning viewer sees is a ten-minute-old number.
        if (wasIdle) this.#heap.schedule({ id: spec.key, dueAt: this.#deps.now(), value: spec.key })
      }
    }

    this.#rearm()

    let released = false
    return () => {
      if (released) return
      released = true
      if (!observed) return
      const registration = this.#registrations.get(spec.key)
      if (registration === undefined) return
      registration.subscribers = Math.max(0, registration.subscribers - 1)
      if (registration.subscribers === 0) registration.unobservedSince = this.#deps.now()
    }
  }

  /** Forget a fetch entirely, used when a widget is deleted. */
  unregister(key: string): void {
    this.#registrations.delete(key)
    this.#heap.cancel(key)
    this.cache.delete(key)
    this.#queue = this.#queue.filter((queued) => queued !== key)
    this.#rearm()
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#rearm()
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== null) {
      this.#deps.clearTimer(this.#timer)
      this.#timer = null
    }
  }

  view(key: string): CacheView | undefined {
    return this.cache.view(key, this.#deps.now())
  }

  /** Run everything currently due. Exposed so tests drive time rather than wait for it. */
  async tick(): Promise<void> {
    const now = this.#deps.now()
    for (const entry of this.#heap.drain(now)) this.#queue.push(entry.value)
    await this.#pump()
    this.#rearm()
  }

  async #pump(): Promise<void> {
    const started: Promise<void>[] = []
    while (this.#queue.length > 0 && this.#active < this.#deps.concurrency) {
      const key = this.#queue.shift() as string
      const registration = this.#registrations.get(key)
      if (registration === undefined || registration.inFlight) continue
      started.push(this.#run(key, registration))
    }
    await Promise.all(started)
  }

  async #run(key: string, registration: Registration): Promise<void> {
    registration.inFlight = true
    this.#active++
    const at = new Date(this.#deps.now()).toISOString()

    try {
      const outcome = await registration.spec.execute()
      if (outcome.ok) {
        const { changed } = this.cache.succeed(key, outcome.projection, at)
        // Only a real content change is announced. Most polls return the same numbers, and
        // waking every browser for them is pure cost.
        if (changed) this.#emit(key)
      } else {
        this.cache.fail(key, outcome.code, at, registration.spec.intervalMs)
        this.#emit(key)
      }
    } catch {
      // An executor that throws is a bug, but it must not stop the scheduler for everyone else.
      this.cache.fail(key, 'internal', at, registration.spec.intervalMs)
      this.#emit(key)
    } finally {
      registration.inFlight = false
      this.#active--
      this.#reschedule(key, registration)
    }
  }

  #emit(key: string): void {
    const view = this.cache.view(key, this.#deps.now())
    if (view === undefined) return
    for (const listener of this.#listeners) listener(key, view)
  }

  #reschedule(key: string, registration: Registration): void {
    if (!this.#registrations.has(key)) return
    const now = this.#deps.now()
    const entry = this.cache.raw(key)
    const interval = nextIntervalMs({
      baseIntervalMs: registration.spec.intervalMs,
      consecutiveFailures: entry?.consecutiveFailures ?? 0,
      subscribers: registration.subscribers,
      unobservedForMs:
        registration.unobservedSince === null ? 0 : now - registration.unobservedSince,
      policy: this.#deps.policy,
    })
    this.#heap.schedule({
      id: key,
      dueAt: now + withJitter(interval, this.#deps.random),
      value: key,
    })
  }

  /** Point the single timer at whatever is due next. */
  #rearm(): void {
    if (!this.#running) return
    if (this.#timer !== null) {
      this.#deps.clearTimer(this.#timer)
      this.#timer = null
    }
    const next = this.#heap.peek()
    if (next === undefined) return
    const delay = Math.max(0, next.dueAt - this.#deps.now())
    this.#timer = this.#deps.setTimer(() => {
      void this.tick()
    }, delay)
  }
}
