import type { Json } from '@neohomepage/catalog-schema'
import { nextIntervalMs, withJitter } from './backoff.ts'
import { ProjectionCache, type CacheView } from './cache.ts'
import { TimerHeap } from './heap.ts'

/**
 * Poll scheduler shared by every browser tab: one heap, one timer, one in-flight budget. Clock,
 * randomness, timer and executor are injected so tests can drive time.
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

  readonly #deps: Required<SchedulerDeps>

  constructor(deps: SchedulerDeps) {
    this.#deps = {
      now: deps.now,
      random: deps.random ?? Math.random,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      concurrency: deps.concurrency ?? 4,
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
   * Every registered key, fetched or not; reconciliation must iterate this rather than the cache,
   * which lacks keys that have not succeeded yet.
   */
  registeredKeys(): string[] {
    return [...this.#registrations.keys()]
  }

  /**
   * Register a fetch or add a subscriber to an existing one; returns an unsubscribe bound to this
   * reference.
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
      // First registration fetches immediately so a fresh page is not blank for a full interval.
      this.#heap.schedule({ id: spec.key, dueAt: this.#deps.now(), value: spec.key })
    } else {
      existing.spec = spec
      if (observed) {
        const wasIdle = existing.subscribers === 0
        existing.subscribers++
        existing.unobservedSince = null
        // Waking from idle fetches now instead of waiting out the decayed interval.
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

  /** Fetch one key now, ignoring its backoff; used by the refresh button and "test connection". */
  async refreshNow(key: string): Promise<void> {
    const registration = this.#registrations.get(key)
    if (registration === undefined || registration.inFlight) return
    await this.#run(key, registration)
  }

  /** Run everything currently due. Exposed so tests drive time rather than wait for it. */
  async tick(): Promise<void> {
    const now = this.#deps.now()
    for (const entry of this.#heap.drain(now)) this.#queue.push(entry.value)
    await this.#pump()
    this.#rearm()
  }

  async #pump(): Promise<void> {
    const worker = async (): Promise<void> => {
      while (this.#queue.length > 0) {
        const key = this.#queue.shift() as string
        const registration = this.#registrations.get(key)
        if (registration === undefined || registration.inFlight) continue
        await this.#run(key, registration)
      }
    }
    // Count the free slots BEFORE starting any worker: #run increments #active synchronously.
    const slots = Math.min(this.#deps.concurrency - this.#active, this.#queue.length)
    const workers: Promise<void>[] = []
    for (let i = 0; i < slots; i++) workers.push(worker())
    await Promise.all(workers)
  }

  async #run(key: string, registration: Registration): Promise<void> {
    registration.inFlight = true
    this.#active++
    const at = new Date(this.#deps.now()).toISOString()

    try {
      const outcome = await registration.spec.execute()
      if (outcome.ok) {
        const { changed } = this.cache.succeed(key, outcome.projection, at)
        // Only a real content change is announced; most polls return identical data.
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
