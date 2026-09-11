import chokidar, { type FSWatcher } from 'chokidar'

/**
 * Watches the config directory so external edits show up without a restart. Own writes are
 * recognised by content revision rather than a timer, which races on slow disks; polling is
 * opt-in because `fs.watch` does not fire on SMB, NFS, virtiofs and some LXC bind mounts.
 */

export type WatcherOptions = {
  readonly directory: string
  /** Called once per debounced burst of file events. */
  readonly onChange: () => void | Promise<void>
  readonly debounceMs?: number
  readonly usePolling?: boolean
}

export class ConfigWatcher {
  #watcher: FSWatcher | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #expected = new Set<string>()
  readonly #options: WatcherOptions

  constructor(options: WatcherOptions) {
    this.#options = options
  }

  /**
   * Marks a revision as the app's own write so its watcher echo is dropped. Consumed once, so an
   * external edit that restores the same content still gets through.
   */
  expect(revision: string): void {
    this.#expected.add(revision)
  }

  /** Returns true when this revision was the app's own write. */
  consumeExpected(revision: string): boolean {
    return this.#expected.delete(revision)
  }

  start(): void {
    if (this.#watcher !== null) return
    this.#watcher = chokidar.watch(this.#options.directory, {
      ignoreInitial: true,
      // Avoids parsing a half-written JSON file.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      usePolling: this.#options.usePolling ?? process.env.NEOHOMEPAGE_WATCH_POLLING === '1',
      // The audit log changes on every write; watching it would reload after each own write.
      ignored: (path: string) => path.endsWith('.audit.jsonl'),
    })

    const schedule = () => {
      if (this.#timer !== null) clearTimeout(this.#timer)
      this.#timer = setTimeout(() => {
        this.#timer = null
        void this.#options.onChange()
      }, this.#options.debounceMs ?? 300)
    }

    this.#watcher.on('add', schedule)
    this.#watcher.on('change', schedule)
    this.#watcher.on('unlink', schedule)
    this.#watcher.on('error', (error) => {
      console.warn(`config watcher: ${error instanceof Error ? error.message : String(error)}`)
      console.warn(
        'set NEOHOMEPAGE_WATCH_POLLING=1 if the config directory is on SMB, NFS or a bind mount',
      )
    })
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    await this.#watcher?.close()
    this.#watcher = null
  }
}
