import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers'
import type { Manifest, SingleManifest, SourceKind } from '@neohomepage/catalog-schema'
import { isComposite } from '@neohomepage/catalog-schema'
import { IconStore, type IconFetch } from './assets/icons.ts'
import { loadCatalogDirectory } from './catalog/load.ts'
import { effectiveSections } from './config/sections.ts'
import { fetchUpstream } from './fetcher/client.ts'
import { overridesSchema, EMPTY_OVERRIDES, type Overrides } from './config/overrides.ts'
import { env } from './env.ts'
import { executeOperation, executeSource } from './fetcher/execute.ts'
import { composeSources, type SourcePart } from '../shared/compose.ts'
import { EventHub } from './http/events.ts'
import {
  assetsFingerprint,
  currentAssetTags,
  publish,
  type PublishResult,
} from './render/publish.ts'
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
  state(): Promise<{ resolved: Resolved; revision: string; tree: ConfigTree }>
  widgetData(): Record<string, unknown>
  pending(): Promise<{ pending: boolean; generation: number | null; revision: string }>
  refreshWidget(widgetId: string): Promise<boolean>
  writeSecrets(values: Readonly<Record<string, string>>): Promise<void>
  deleteSecrets(names: readonly string[]): Promise<void>
  catalog(): ReadonlyMap<string, Manifest>
  requestPublish(actor: string, mode?: PublishMode): Promise<PublishResult | null>
  publishNow(actor: string, label?: string): Promise<PublishResult>
  /** The icon cache: what is on disk, and where a cached slug is served from. */
  icons(): IconStore
  shutdown(): Promise<void>
}

export type ContextOptions = {
  readonly catalogDir?: string
  readonly webDistDir?: string
  /** Auto-publish debounce. Twelve rapid edits become one render. */
  readonly publishDebounceMs?: number
  readonly publishMode?: PublishMode
  /**
   * How an icon slug becomes bytes. Defaults to the real CDN fetch — except under vitest, where
   * a test that adds a Sonarr widget must not reach the internet for Sonarr's logo. `null`
   * disables fetching outright; cached icons are still served.
   */
  readonly iconFetch?: IconFetch | null
}

/** One icon over the same client every widget uses, so the egress policy is the same policy. */
const fetchIconFromCdn: IconFetch = async (url, maxBytes) => {
  try {
    const response = await fetchUpstream({
      url: new URL(url),
      method: 'GET',
      binary: true,
      limits: { maxBodyBytes: maxBytes },
    })
    return response.status === 200 && !response.truncated ? (response.bytes ?? null) : null
  } catch {
    return null
  }
}

/** Every icon slug the config names: each widget's manifest, each bookmark, each navbar link. */
function iconSlugs(tree: ConfigTree, catalog: ReadonlyMap<string, Manifest>): Set<string> {
  const slugs = new Set<string>()
  // The whole catalog, not only the placed types: the picker shows an icon per type, and
  // sixteen small files once is cheaper than a picker of initials.
  for (const manifest of catalog.values()) slugs.add(manifest.icon)
  for (const page of tree.pages.values()) {
    for (const section of effectiveSections(page)) {
      if (section.kind === 'bookmarks') {
        for (const group of section.groups)
          for (const link of group.links) if (link.icon !== null) slugs.add(link.icon)
      }
      if (section.kind === 'navbar') {
        for (const item of section.items) {
          if (item.kind === 'links')
            for (const link of item.links) if (link.icon !== null) slugs.add(link.icon)
        }
      }
    }
  }
  return slugs
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

  const iconFetch =
    options.iconFetch === undefined
      ? process.env.VITEST === undefined
        ? fetchIconFromCdn
        : null
      : options.iconFetch
  const icons = new IconStore(env.stateDir, iconFetch ?? (async () => null))
  await icons.load()
  let fetchingIcons = false

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
      icons: icons.available(),
      // Stamped once per resolve so two runs over identical inputs differ only here, which keeps
      // the publish step's no-op detection meaningful.
      generatedAt: new Date().toISOString(),
    })

    await resubscribe(loaded.tree, resolved as Resolved)
    void fetchMissingIcons(loaded.tree)
  }

  /**
   * Icons arrive after the fact: the page renders with an initial where an icon is not cached
   * yet, the fetch runs behind the render, and a rebuild (plus a publish) follows once something
   * has landed. One pass at a time — a burst of edits must not start a burst of fetches.
   */
  async function fetchMissingIcons(current: ConfigTree): Promise<void> {
    if (iconFetch === null || fetchingIcons) return
    fetchingIcons = true
    try {
      const arrived = await icons.ensure(iconSlugs(current, catalog), {
        offline: current.network.mode === 'offline',
      })
      if (arrived.length === 0) return
      await rebuild()
      hub.broadcast({ type: 'config', data: { revision } })
      await context.requestPublish('icons')
    } catch (error) {
      console.warn(`icons: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      fetchingIcons = false
    }
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
      if (widget.unsupported) continue
      const manifest = catalog.get(widget.type)
      if (manifest === undefined) continue

      for (const source of widgetSources(widget, manifest, current)) {
        live.add(source.key)
        releases.push(
          scheduler.register(
            {
              key: source.key,
              intervalMs: widget.pollIntervalMs,
              execute: async () => {
                const secrets: Record<string, string> = {}
                for (const [field, ref] of Object.entries(source.target.secrets)) {
                  const value = vault.get(ref.$secret)
                  if (value !== undefined) secrets[field] = value
                }
                const binding = {
                  origin: source.origin,
                  basePath: source.target.base.basePath,
                  allowLoopback:
                    source.target.base.host === '127.0.0.1' ||
                    source.target.base.host === 'localhost',
                  insecureSkipVerify: source.target.tls.insecureSkipVerify,
                }
                const auth = { secrets, config: source.target.fields }
                const now = new Date().toISOString()

                const result =
                  'kind' in source
                    ? await executeSource({
                        source: source.kind,
                        target: binding,
                        config: widget.config,
                        auth,
                        now,
                      })
                    : await executeOperation({
                        manifest: source.manifest,
                        operation: source.operation,
                        target: binding,
                        config: widget.config,
                        auth,
                        now,
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

    for (const key of scheduler.registeredKeys()) {
      if (!live.has(key)) scheduler.unregister(key)
    }
  }

  /**
   * Every upstream fetch one widget needs, with the target and code path for each.
   *
   * Single-source widgets produce one entry per declared operation; a composite produces one per
   * bound target per role. Both go through the same registration below, which is what keeps the
   * "two widgets on the same Sonarr share one fetch" property true for composites too: the key is
   * derived from what is requested, never from who asked.
   */
  type BoundTarget = NonNullable<ReturnType<ConfigTree['targets']['get']>>

  type WidgetSource = {
    readonly key: string
    readonly target: BoundTarget
    readonly origin: string
  } & (
    | { readonly kind: SourceKind }
    | { readonly manifest: SingleManifest; readonly operation: string }
  )

  function widgetSources(
    widget: Resolved['widgets'][number],
    manifest: Manifest,
    current: ConfigTree,
  ): WidgetSource[] {
    const sources: WidgetSource[] = []

    const bind = (target: BoundTarget) => {
      const origin = `${target.base.scheme}://${target.base.host}:${target.base.port}`
      return { origin, revision: `${origin}${target.base.basePath}` }
    }

    if (isComposite(manifest)) {
      for (const [roleName, role] of Object.entries(manifest.roles)) {
        for (const targetId of widget.bindings[roleName] ?? []) {
          const target = current.targets.get(targetId)
          if (target === undefined) continue
          // The target's own shape decides which source kind applies. A Sonarr bound into a
          // calendar role is fetched as a Sonarr; there is no place for the user to get this
          // wrong, and no place for a manifest to name a path for a service it was not given.
          const kind = role.kinds[target.widgetType]
          if (kind === undefined) continue
          const { origin, revision } = bind(target)
          sources.push({
            key: fetchKey({
              targetId: target.id,
              targetRevision: revision,
              // The manifest id is part of the operation identity because two composites over the
              // same upstream project different items from it, so their cached values differ.
              operation: `${manifest.id}:${roleName}:${target.widgetType}`,
              params: widget.config,
            }),
            target,
            origin,
            kind,
          })
        }
      }
      return sources
    }

    if (widget.targetId === null) return sources
    const target = current.targets.get(widget.targetId)
    if (target === undefined) return sources
    const { origin, revision } = bind(target)

    for (const operation of widget.operations) {
      sources.push({
        key: fetchKey({
          targetId: target.id,
          targetRevision: revision,
          operation,
          params: widget.config,
        }),
        target,
        origin,
        manifest,
        operation,
      })
    }
    return sources
  }

  /** The cache keys a widget reads, in binding order. Empty when it is not fetchable yet. */
  function widgetKeys(widget: Resolved['widgets'][number]): string[] {
    if (tree === null) return []
    const manifest = catalog.get(widget.type)
    if (manifest === undefined) return []
    return widgetSources(widget, manifest, tree).map((source) => source.key)
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
      return { resolved: resolved as Resolved, revision, tree: tree as ConfigTree }
    },

    /**
     * Refresh one widget now.
     *
     * The caller names a WIDGET, never a URL. The server resolves it to a fetch key and the key to
     * a request — which is the whole invariant, stated as an endpoint.
     */
    async refreshWidget(widgetId: string) {
      if (resolved === null) await rebuild()
      const widget = (resolved as Resolved).widgets.find((candidate) => candidate.id === widgetId)
      if (widget === undefined) return false
      const keys = widgetKeys(widget)
      if (keys.length === 0) return false
      // A composite refreshes all of its bindings, in parallel: asking for "the calendar" and
      // getting only the first of five calendars refreshed would be a puzzling button.
      await Promise.all(keys.map((key) => scheduler.refreshNow(key)))
      return true
    },

    catalog() {
      return catalog
    },

    /**
     * Store secret values.
     *
     * The only writer of the secrets directory, and the reason config can never contain a
     * credential: the write API hands values here and puts a `$secret` reference in the tree.
     * Mode 0600, in a directory the seeder already excluded from git.
     */
    async writeSecrets(values) {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { writeFileDurable } = await import('./store/atomic.ts')
      const path = join(env.secretsDir, 'secrets.json')

      let existing: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      } catch {
        // First secret on a fresh install.
      }
      await writeFileDurable(path, `${JSON.stringify({ ...existing, ...values }, null, 2)}\n`, {
        mode: 0o600,
      })
    },

    /** Remove secrets whose owning target is gone. */
    async deleteSecrets(names) {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { writeFileDurable } = await import('./store/atomic.ts')
      const path = join(env.secretsDir, 'secrets.json')

      let existing: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      } catch {
        return
      }
      for (const name of names) delete existing[name]
      await writeFileDurable(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 })
    },

    widgetData() {
      const data: Record<string, unknown> = {}
      if (resolved === null) return data
      for (const widget of resolved.widgets) {
        const manifest = catalog.get(widget.type)
        if (manifest === undefined) continue
        const keys = widgetKeys(widget)
        if (keys.length === 0) continue

        if (!isComposite(manifest)) {
          const view = scheduler.view(keys[0] as string)
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
          continue
        }

        const parts = keys.map((key) => partFor(key))
        // Nothing has answered yet on any binding: leave the widget out entirely so the client
        // shows its loading state, exactly as a single-source widget does before its first fetch.
        if (parts.every((part) => part.pending)) continue
        const composed = composeSources(manifest.compose, parts)
        data[widget.id] = {
          projection: composed.projection,
          meta: composed.meta,
          sources: composed.sources,
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
      // Two ways to be out of date: the config moved, or the app did. The second is what an
      // upgrade looks like — same config, different bundle filenames — and missing it leaves the
      // published page loading a script the new build deleted.
      const assetsHash = assetsFingerprint(await currentAssetTags(options.webDistDir))
      return {
        pending:
          meta === null || meta.configRevision !== revision || meta.assetsHash !== assetsHash,
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

    icons() {
      return icons
    },

    async shutdown() {
      scheduler.stop()
      hub.closeAll()
      await watcher.stop()
      if (debounce !== null) clearNodeTimeout(debounce)
    },
  }

  /**
   * One cache key can feed several widgets, and a composite is fed by several keys.
   *
   * So an update fans out to every widget that reads the key, and each is re-composed before it
   * is broadcast — the browser receives finished widget state, never a fragment it would have to
   * know how to merge.
   */
  scheduler.onUpdate((key, entry) => {
    if (resolved === null) return
    for (const widget of resolved.widgets) {
      const keys = widgetKeys(widget)
      if (!keys.includes(key)) continue
      const manifest = catalog.get(widget.type)
      if (manifest === undefined) continue

      const payload = isComposite(manifest)
        ? (() => {
            const composed = composeSources(manifest.compose, keys.map(partFor))
            return { projection: composed.projection, meta: composed.meta }
          })()
        : {
            projection: entry.projection,
            meta: { state: entry.state, ageMs: entry.ageMs, errorCode: entry.errorCode },
          }

      hub.broadcast({ type: 'widget', data: { id: widget.id, ...payload } })
    }
  })

  /** One cache key as a compose input. An unfetched key is pending, not failed. */
  function partFor(key: string): SourcePart {
    const view = scheduler.view(key)
    if (view === undefined) {
      return {
        key,
        pending: true,
        ok: false,
        items: [],
        fetchedAt: null,
        ageMs: 0,
        state: 'error',
        errorCode: null,
      }
    }
    const projection = view.projection as { items?: SourcePart['items'] } | null
    return {
      key,
      pending: false,
      ok: view.state !== 'error' && projection !== null,
      items: projection?.items ?? [],
      fetchedAt: view.fetchedAt,
      ageMs: view.ageMs,
      state: view.state,
      errorCode: view.errorCode,
    }
  }

  return context
}
