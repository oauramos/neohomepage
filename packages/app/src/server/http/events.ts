/**
 * Server-sent-events hub. One EventSource per tab, deliberately: cross-tab leader election fails
 * invisibly when the leader tab dies, and only reproduces with several tabs open.
 */

export type ServerEvent = {
  readonly type: 'widget' | 'config' | 'published' | 'hello'
  readonly data: unknown
}

export type Subscriber = {
  readonly id: number
  send(event: ServerEvent): void
  close(): void
}

export type HubOptions = {
  /** Beyond this, new connections are refused rather than degrading everyone's. */
  readonly maxClients?: number
  /** A comment frame often enough to keep proxies from reaping an idle connection. */
  readonly keepAliveMs?: number
}

export class EventHub {
  #subscribers = new Map<number, Subscriber>()
  #nextId = 1
  readonly #maxClients: number
  readonly #keepAliveMs: number

  constructor(options: HubOptions = {}) {
    this.#maxClients = options.maxClients ?? 32
    this.#keepAliveMs = options.keepAliveMs ?? 20_000
  }

  get size(): number {
    return this.#subscribers.size
  }

  get keepAliveMs(): number {
    return this.#keepAliveMs
  }

  get atCapacity(): boolean {
    return this.#subscribers.size >= this.#maxClients
  }

  add(subscriber: Omit<Subscriber, 'id'>): { id: number; release: () => void } {
    const id = this.#nextId++
    const entry: Subscriber = { id, ...subscriber }
    this.#subscribers.set(id, entry)
    return {
      id,
      release: () => {
        this.#subscribers.delete(id)
      },
    }
  }

  /**
   * A subscriber whose write throws is dropped, not retried: buffering for a slow consumer
   * inflates RSS.
   */
  broadcast(event: ServerEvent): number {
    let delivered = 0
    for (const [id, subscriber] of [...this.#subscribers]) {
      try {
        subscriber.send(event)
        delivered++
      } catch {
        this.#subscribers.delete(id)
        try {
          subscriber.close()
        } catch {
          // Already gone; nothing to do.
        }
      }
    }
    return delivered
  }

  closeAll(): void {
    for (const subscriber of this.#subscribers.values()) {
      try {
        subscriber.close()
      } catch {
        // Already gone.
      }
    }
    this.#subscribers.clear()
  }
}

/** Serialise one event in the SSE wire format. */
export function formatEvent(event: ServerEvent): string {
  const payload = JSON.stringify(event.data)
  // Every line of a multi-line payload needs its own `data:` prefix, and JSON.stringify can
  // produce one for a string containing a newline.
  const lines = payload.split('\n').map((line) => `data: ${line}`)
  return `event: ${event.type}\n${lines.join('\n')}\n\n`
}

export const KEEPALIVE_FRAME = ': keepalive\n\n'
