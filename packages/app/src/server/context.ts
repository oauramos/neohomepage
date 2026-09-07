import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers'
import type { Manifest } from '@neohomepage/catalog-schema'
import { loadCatalogDirectory } from './catalog/load.ts'
import { overridesSchema, EMPTY_OVERRIDES, type Overrides } from './config/overrides.ts'
import { env } from './env.ts'
import { executeOperation } from './fetcher/execute.ts'
import { EventHub } from './http/events.ts'
import { publish, type PublishResult } from './render/publish.ts'
import { resolve as resolveTree, type Resolved } from './resolve/resolve.ts'
import { PollScheduler } from './scheduler/scheduler.ts'
import { fetchKey } from './scheduler/key.ts'
import { loadSecrets } from './secrets/vault.ts'
import { ConfigStore } from './store/configstore.ts'
import { ConfigWatcher } from './store/watcher.ts'
import { Generations } from './store/generations.ts'
import type { ConfigTree } from './store/tree.ts'

/**
 * Everything long-lived, wired together.
 *
 * One process holds one store, one scheduler, one event hub and one publish mutex. The mutex
 * matters: an agent making twelve edits must produce one render, not twelve concurrent ones on a
 * box with two cores.
 */

export type PublishMode = 'auto' | 'manual'

export type AppContext = {
  readonly store: ConfigStore
  readonly generations: Generations
  readonly scheduler: PollScheduler
  readonly hub: EventHub
  readonly watcher: ConfigWatcher
  reload(): Promise<void>
  state(): Promise<{ resolved: Resolved; revision: string }>
  widgetData(): Record<string, unknown>
  pending(): Promise<{ pending: boolean; generation: number | null; revision: string }>
  requestPublish(actor: string, mode?: PublishMode): Promise<PublishResult | null>
  publishNow(actor: string, label?: string): Promise<PublishResult>
  shutdown(): Promise<void>
}

export type ContextOptions = {
  readonly catalogDir?: string
  readonly webDistDir?: string
  /** Auto-publish debounce. Twelve rapid edits become one render. */
  readonly publishDebounceMs?: number
  readonly publishMode?: PublishMode
}

async function readOverrides(path: string): Promise<Overrides> {
  try {
    return overridesSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    // Absent or unreadable is the normal case: this file is per-machine and optional.
    return EMPTY_OVERRIDES
  }
}

export async function createContext(options: ContextOptions = {}): Promise<AppContext> {
  const store = new ConfigStore(env.configDir)
  const generations = new Generations(env.stateDir)
  const hub = new EventHub()
  const debounceMs = options.publishDebounceMs ?? 800
  const mode: PublishMode = options.publishMode ?? 'auto'

  const scheduler = new PollScheduler({
    now: () => Date.now(),
    setTimer: (callback, delay) => setNodeTimeout(callback, delay),
    clearTimer: (handle) => clearNodeTimeout(handle as ReturnType<typeof setNodeTimeout>),
  })

  let catalog: ReadonlyMap<string, Manifest> = new Map()
  let tree: ConfigTree | null = null
  let revision = ''
  let resolved: Resolved | null = null
  let releases: (() => void)[] = []

  let publishing: Promise<PublishResult> | null = null
  let debounce: ReturnType<typeof setNodeTimeout> | null = null

  /**
   * A hand edit, or a `git pull`, must show up without a restart — and must not be mistaken for
   * the app's own write. The guard is the revision we just produced, not a time window.
   */
  const watcher = new ConfigWatcher({
    directory: env.configDir,
    onChange: async () => {
      const before = revision
      await rebuild()
      if (revision === before) return
      if (watcher.consumeExpected(revision)) return
      console.log(`config changed on disk (revision ${revision})`)
      hub.broadcast({ type: 'config', data: { revision } })
      await context.requestPublish('watcher')
    },
  })

  async function rebuild(): Promise<void> {
    const loaded = await store.load()
    tree = loaded.tree
    revision = loaded.revision

    const overrides = await readOverrides(store.paths.overrides)
    resolved = resolveTree({
      tree: loaded.tree,
      catalog,
      overrides,
      // Stamped once per resolve so two runs over identical inputs differ only here, which keeps
      // the publish step's no-op detection meaningful.
      generatedAt: new Date().toISOString(),
    })

    await resubscribe(loaded.tree, resolved as Resolved)
  }

  /**
   * Point the scheduler at exactly the fetches the current config needs.
   *
   * Releasing every previous subscription before taking new ones means a widget that was deleted
   * stops being polled, and one that survived keeps its cached projection because the key is the
   * same.
   */
  async function resubscribe(current: ConfigTree, current_resolved: Resolved): Promise<void> {
    for (const release of releases) release()
    releases = []

    const vault = await loadSecrets(env.secretsDir)
    const live = new Set<string>()

    for (const widget of current_resolved.widgets) {
      if (widget.unsupported || widget.targetId === null) continue
      const target = current.targets.get(widget.targetId)
      const manifest = catalog.get(widget.type)
      if (target === undefined || manifest === undefined) continue

      const origin = `${target.base.scheme}://${target.base.host}:${target.base.port}`
      const targetRevision = `${origin}${target.base.basePath}`

      for (const operation of widget.operations) {
        const key = fetchKey({
          targetId: target.id,
          targetRevision,
          operation,
          params: widget.config,
        })
        live.add(key)
        releases.push(
          scheduler.register(
            {
              key,
              intervalMs: widget.pollIntervalMs,
              execute: async () => {
                const secrets: Record<string, string> = {}
                for (const [field, ref] of Object.entries(target.secrets)) {
                  const value = vault.get(ref.$secret)
                  if (value !== undefined) secrets[field] = value
                }
                const result = await executeOperation({
                  manifest,
                  operation,
                  target: {
                    origin,
                    basePath: target.base.basePath,
                    allowLoopback:
                      target.base.host === '127.0.0.1' || target.base.host === 'localhost',
                    insecureSkipVerify: target.tls.insecureSkipVerify,
                  },
                  config: widget.config,
                  auth: { secrets, config: target.fields },
                  now: new Date().toISOString(),
                })
                return result.ok
                  ? { ok: true, projection: result.projection }
                  : { ok: false, code: result.code }
              },
            },
            // Nothing is observed until a browser connects; the scheduler decays accordingly.
            { observed: hub.size > 0 },
          ),
        )
      }
    }

    for (const key of scheduler.cache.keys()) {
      if (!live.has(key)) scheduler.unregister(key)
    }
  }

  function widgetKeyFor(widget: Resolved['widgets'][number]): string | null {
    if (tree === null || widget.targetId === null) return null
    const target = tree.targets.get(widget.targetId)
    if (target === undefined) return null
    const origin = `${target.base.scheme}://${target.base.host}:${target.base.port}`
    const operation = widget.operations[0]
    if (operation === undefined) return null
    return fetchKey({
      targetId: target.id,
      targetRevision: `${origin}${target.base.basePath}`,
      operation,
      params: widget.config,
    })
  }

  const context: AppContext = {
    store,
    generations,
    scheduler,
    hub,

    async reload() {
      const loadedCatalog = await loadCatalogDirectory(
        options.catalogDir ?? join(process.cwd(), 'catalog'),
      )
      catalog = loadedCatalog.manifests
      for (const rejected of loadedCatalog.rejected) {
        console.warn(`catalog: skipped ${rejected.slug} — ${rejected.reason}`)
      }
      await rebuild()
    },

    async state() {
      if (resolved === null) await rebuild()
      return { resolved: resolved as Resolved, revision }
    },

    widgetData() {
      const data: Record<string, unknown> = {}
      if (resolved === null) return data
      for (const widget of resolved.widgets) {
        const key = widgetKeyFor(widget)
        if (key === null) continue
        const view = scheduler.view(key)
        if (view === undefined) continue
        data[widget.id] = {
          projection: view.projection,
          meta: {
            fetchedAt: view.fetchedAt,
            ageMs: view.ageMs,
            state: view.state,
            ...(view.errorCode === null ? {} : { errorCode: view.errorCode }),
          },
        }
      }
      return data
    },

    /**
     * Whether the config on disk is ahead of what is published.
     *
     * This is what the editor's badge counts. It compares the current config revision with the one
     * recorded in the served generation, so a hand-edit outside the app shows up too.
     */
    async pending() {
      if (resolved === null) await rebuild()
      const current = await generations.current()
      if (current === null) return { pending: true, generation: null, revision }
      const meta = await generations.meta(current)
      return {
        pending: meta === null || meta.configRevision !== revision,
        generation: current,
        revision,
      }
    },

    /**
     * Publish, honouring the configured mode.
     *
     * In manual mode this returns null and leaves the badge to do its work; in auto mode it
     * debounces, so twelve edits from an agent produce one render rather than twelve.
     */
    async requestPublish(actor: string, requestedMode: PublishMode = mode) {
      if (requestedMode === 'manual') return null
      if (debounce !== null) clearNodeTimeout(debounce)
      await new Promise<void>((settle) => {
        debounce = setNodeTimeout(() => {
          debounce = null
          settle()
        }, debounceMs)
      })
      return context.publishNow(actor)
    },

    async publishNow(actor: string, label?: string) {
      // One render at a time. Two concurrent publishes would race for the generation number and
      // the pointer, on a box that cannot afford either one twice.
      if (publishing !== null) return publishing
      publishing = (async () => {
        await rebuild()
        watcher.expect(revision)
        const result = await publish({
          resolved: resolved as Resolved,
          stateDir: env.stateDir,
          configDir: env.configDir,
          configRevision: revision,
          actor,
          ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
          ...(label === undefined ? {} : { label }),
        })
        await generations.prune(10)
        hub.broadcast({ type: 'published', data: { generation: result.generation, revision } })
        return result
      })()
      try {
        return await publishing
      } finally {
        publishing = null
      }
    },

    watcher,

    async shutdown() {
      scheduler.stop()
      hub.closeAll()
      await watcher.stop()
      if (debounce !== null) clearNodeTimeout(debounce)
    },
  }

  scheduler.onUpdate((key, entry) => {
    if (resolved === null) return
    const widget = resolved.widgets.find((candidate) => widgetKeyFor(candidate) === key)
    if (widget === undefined) return
    hub.broadcast({
      type: 'widget',
      data: {
        id: widget.id,
        projection: entry.projection,
        meta: { state: entry.state, ageMs: entry.ageMs, errorCode: entry.errorCode },
      },
    })
  })

  return context
}
