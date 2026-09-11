/**
 * Binary min-heap keyed by due time, so the scheduler runs one timer rather than one per widget.
 * Entries are matched by id; a reschedule or cancel is O(n) to find and O(log n) to reheap.
 */

export type HeapEntry<T> = {
  readonly id: string
  readonly dueAt: number
  readonly value: T
}

export class TimerHeap<T> {
  #entries: HeapEntry<T>[] = []
  #index = new Map<string, number>()

  get size(): number {
    return this.#entries.length
  }

  has(id: string): boolean {
    return this.#index.has(id)
  }

  peek(): HeapEntry<T> | undefined {
    return this.#entries[0]
  }

  /** Insert, or move an existing id to a new due time. */
  schedule(entry: HeapEntry<T>): void {
    const existing = this.#index.get(entry.id)
    if (existing === undefined) {
      this.#entries.push(entry)
      this.#index.set(entry.id, this.#entries.length - 1)
      this.#up(this.#entries.length - 1)
      return
    }
    this.#entries[existing] = entry
    this.#up(existing)
    this.#down(this.#index.get(entry.id) as number)
  }

  cancel(id: string): boolean {
    const at = this.#index.get(id)
    if (at === undefined) return false
    const last = this.#entries.pop() as HeapEntry<T>
    this.#index.delete(id)
    if (at < this.#entries.length) {
      this.#entries[at] = last
      this.#index.set(last.id, at)
      this.#up(at)
      this.#down(this.#index.get(last.id) as number)
    }
    return true
  }

  /** Remove and return every entry due at or before `now`, earliest first. */
  drain(now: number): HeapEntry<T>[] {
    const due: HeapEntry<T>[] = []
    while (this.#entries.length > 0 && (this.#entries[0] as HeapEntry<T>).dueAt <= now) {
      const top = this.#entries[0] as HeapEntry<T>
      this.cancel(top.id)
      due.push(top)
    }
    return due
  }

  #swap(a: number, b: number): void {
    const x = this.#entries[a] as HeapEntry<T>
    const y = this.#entries[b] as HeapEntry<T>
    this.#entries[a] = y
    this.#entries[b] = x
    this.#index.set(y.id, a)
    this.#index.set(x.id, b)
  }

  #up(start: number): void {
    let at = start
    while (at > 0) {
      const parent = (at - 1) >> 1
      const parentEntry = this.#entries[parent] as HeapEntry<T>
      const current = this.#entries[at] as HeapEntry<T>
      if (parentEntry.dueAt <= current.dueAt) break
      this.#swap(at, parent)
      at = parent
    }
  }

  #down(start: number): void {
    let at = start
    for (let guard = 0; guard < this.#entries.length + 1; guard++) {
      const left = at * 2 + 1
      const right = left + 1
      let smallest = at
      const smallestEntry = () => this.#entries[smallest] as HeapEntry<T>
      if (
        left < this.#entries.length &&
        (this.#entries[left] as HeapEntry<T>).dueAt < smallestEntry().dueAt
      ) {
        smallest = left
      }
      if (
        right < this.#entries.length &&
        (this.#entries[right] as HeapEntry<T>).dueAt < smallestEntry().dueAt
      ) {
        smallest = right
      }
      if (smallest === at) return
      this.#swap(at, smallest)
      at = smallest
    }
  }
}
