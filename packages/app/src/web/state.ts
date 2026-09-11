import type { ProjectionEnvelope } from '@neohomepage/catalog-schema'
import type { Resolved } from '../shared/resolved.ts'

/** Client state: the published HTML renders without the network; this keeps it current. */

export type DashboardState = {
  readonly resolved: Resolved
  readonly data: Readonly<Record<string, ProjectionEnvelope | undefined>>
  readonly revision: string
  readonly generation: number | null
  readonly pending: boolean
  readonly connected: boolean
}

/**
 * State the publish step baked into the document; null on the SPA shell fallback, where the
 * caller asks the server instead.
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
   * Connects the live feed; reconnects with backoff capped at 30s so a restarting server is not
   * hammered.
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

  /**
   * JSON write, then a resync. The content type goes on every request, body or not: the write gate
   * rejects anything a cross-site form could send, and a body-less DELETE without it looks like one.
   * The refresh runs even when the write was refused, so the page shows the server's state.
   */
  async write(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<void> {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    await this.refresh()
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`)
  }

  publish(): Promise<void> {
    return this.write('POST', '/api/publish')
  }
}
