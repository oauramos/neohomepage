import chokidar, { type FSWatcher } from 'chokidar'

/**
 * Watch the config directory so a hand edit — or a `git pull` — shows up without a restart.
 *
 * Two things make this reliable rather than a source of "works on my machine":
 *
 * The self-write guard is a CONTENT HASH, not a timer. Every write the app makes also fires the
 * watcher, and suppressing that with "ignore events for 500ms after we write" is a race that
 * shows up as a lost edit exactly when the disk is slow — which is to say, on a NAS. Recording
 * the revision we just wrote and ignoring an event that reports it is exact.
 *
 * Polling is exposed as an environment variable and documented, because `fs.watch` genuinely does
 * not fire on SMB, NFS, virtiofs and some LXC bind mounts, which are precisely the places this
 * app runs.
 */

export type WatcherOptions = {
  readonly directory: string
  /** Called after the debounce with the revision now on disk. */
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
   * Tell the watcher which revision the app itself just produced.
   *
   * The next reload that reports this revision is our own write echoing back and is dropped. A
   * revision is only expected once: a genuine external edit that happens to restore the same
   * content still gets through the second time.
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
      // A JSON file being written is briefly incomplete; waiting for it to settle avoids parsing
      // a half-written document and reporting a spurious error to the user.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      usePolling: this.#options.usePolling ?? process.env.NEOHOMEPAGE_WATCH_POLLING === '1',
      // The audit log is append-only and changes on every write; watching it would mean every
      // write triggers a reload of the tree it just wrote.
      ignored: (path: string) => path.endsWith('.audit.jsonl') || path.includes('/state/'),
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
