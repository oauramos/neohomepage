import type { ProjectionEnvelope } from '@neohomepage/catalog-schema'
import type { Resolved } from '../shared/resolved.ts'

/**
 * Client state: what the page knows, and how it finds out.
 *
 * The published HTML already contains everything needed to render, so the first paint owes nothing
 * to the network. This module's job is only to keep that picture current.
 */

export type DashboardState = {
  readonly resolved: Resolved
  readonly data: Readonly<Record<string, ProjectionEnvelope | undefined>>
  readonly revision: string
  readonly generation: number | null
  readonly pending: boolean
  readonly connected: boolean
}

/**
 * Read the state the publish step baked into the document.
 *
 * Present on a published page and absent on the SPA shell fallback, which is why the caller
 * treats `null` as "ask the server" rather than as an error.
 */
export function readEmbeddedState(): { resolved: Resolved } | null {
  const element = document.getElementById('__NEO_STATE__')
  if (element === null) return null
  try {
    return JSON.parse(element.textContent ?? '') as { resolved: Resolved }
  } catch {
    return null
  }
}

export type StateListener = (state: DashboardState) => void

export class DashboardClient {
  #state: DashboardState
  #listeners = new Set<StateListener>()
  #events: EventSource | null = null
  #retryMs = 1000

  constructor(initial: DashboardState) {
    this.#state = initial
  }

  get state(): DashboardState {
    return this.#state
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #set(patch: Partial<DashboardState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener(this.#state)
  }

  async refresh(): Promise<void> {
    const response = await fetch('/api/state', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`state request failed: ${response.status}`)
    const payload = (await response.json()) as {
      resolved: Resolved
      data: Record<string, ProjectionEnvelope>
      revision: string
      generation: number | null
      pending: boolean
    }
    this.#set({
      resolved: payload.resolved,
      data: payload.data,
      revision: payload.revision,
      generation: payload.generation,
      pending: payload.pending,
    })
  }

  /**
   * Connect the live feed.
   *
   * Reconnection backs off to 30 seconds rather than retrying tightly: a server that is restarting
   * or a laptop that just closed its lid should not be hammered, and the staleness chip already
   * tells the viewer the page is not live.
   */
  connect(): void {
    if (this.#events !== null) return
    const events = new EventSource('/api/events')
    this.#events = events

    events.addEventListener('open', () => {
      this.#retryMs = 1000
      this.#set({ connected: true })
    })

    events.addEventListener('hello', (event) => {
      this.#set({
        data: JSON.parse((event as MessageEvent<string>).data) as DashboardState['data'],
      })
    })

    events.addEventListener('widget', (event) => {
      const update = JSON.parse((event as MessageEvent<string>).data) as {
        id: string
        projection: unknown
        meta: ProjectionEnvelope['meta']
      }
      this.#set({
        data: {
          ...this.#state.data,
          [update.id]: {
            projection: update.projection,
            meta: update.meta,
          } as ProjectionEnvelope,
        },
      })
    })

    // A config change or a publish elsewhere means this page is looking at an older world.
    events.addEventListener('config', () => void this.refresh())
    events.addEventListener('published', () => void this.refresh())

    events.addEventListener('error', () => {
      this.#set({ connected: false })
      events.close()
      this.#events = null
      const delay = this.#retryMs
      this.#retryMs = Math.min(30_000, this.#retryMs * 2)
      setTimeout(() => this.connect(), delay)
    })
  }

  disconnect(): void {
    this.#events?.close()
    this.#events = null
    this.#set({ connected: false })
  }

  async publish(): Promise<void> {
    await fetch('/api/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    await this.refresh()
  }
}
