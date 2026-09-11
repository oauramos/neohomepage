import { readFile } from 'node:fs/promises'
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers'
import type { Manifest, SingleManifest, SourceKind } from '@neohomepage/catalog-schema'
import { isComposite } from '@neohomepage/catalog-schema'
import { IconStore, type IconFetch } from './assets/icons.ts'
import { loadCatalogDirectory } from './catalog/load.ts'
import type { Target } from './config/schema.ts'
import { effectiveSections } from './config/sections.ts'
import { fetchUpstream } from './fetcher/client.ts'
import { overridesSchema, EMPTY_OVERRIDES, type Overrides } from './config/overrides.ts'
import { env } from './env.ts'
import { executeOperation, executeSource } from './fetcher/execute.ts'
import { isLoopbackHost } from './fetcher/policy.ts'
import { composeSources, type SourcePart } from '../shared/compose.ts'
import type { ResolvedWidget } from '../shared/resolved.ts'
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
import { loadSecrets, readSecretsFile, secretsFile } from './secrets/vault.ts'
import { writeFileDurable } from './store/atomic.ts'
import { ConfigStore } from './store/configstore.ts'
import { ConfigWatcher } from './store/watcher.ts'
import { Generations } from './store/generations.ts'
import type { ConfigTree } from './store/tree.ts'

/**
 * Everything long-lived wired together: one store, one scheduler, one event hub and one publish
 * mutex per process.
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
  icons(): IconStore
  shutdown(): Promise<void>
}

export type ContextOptions = {
  readonly catalogDir?: string
  readonly webDistDir?: string
  readonly publishDebounceMs?: number
  readonly publishMode?: PublishMode
  /**
   * Defaults to the CDN fetch, or null under vitest; null disables fetching but cached icons are
   * still served.
   */
  readonly iconFetch?: IconFetch | null
}

/** Goes through fetchUpstream so icons follow the same egress policy as widgets. */
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

function iconSlugs(tree: ConfigTree, catalog: ReadonlyMap<string, Manifest>): Set<string> {
  const slugs = new Set<string>()
  // Whole catalog, not only placed types: the picker shows an icon per type.
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
  } catch (error) {
    // The file is optional; one that exists but does not parse is a hand edit gone wrong, so warn.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `overrides: ignoring ${path} — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return EMPTY_OVERRIDES
  }
}

export async function createContext(options: ContextOptions = {}): Promise<AppContext> {
  const store = new ConfigStore(env.configDir)
  const generations = new Generations(env.stateDir)
  const hub = new EventHub()
  const debounceMs = options.publishDebounceMs ?? 800
  const mode: PublishMode = options.publishMode ?? 'auto'
  const secretsPath = secretsFile(env.secretsDir)

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
  let debounce: {
    timer: ReturnType<typeof setNodeTimeout>
    fire: () => void
    actor: string
    result: Promise<PublishResult>
  } | null = null

  // The app's own writes are recognised by the revision they produced (watcher.expect), not by
  // a time window.
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

  async function rebuild(): Promise<{ tree: ConfigTree; resolved: Resolved; revision: string }> {
    const loaded = await store.load()
    tree = loaded.tree
    revision = loaded.revision

    const overrides = await readOverrides(store.paths.overrides)
    const next = resolveTree({
      tree: loaded.tree,
      catalog,
      overrides,
      icons: icons.available(),
      // The only field that differs between resolves of identical inputs; publish's no-op
      // detection relies on that.
      generatedAt: new Date().toISOString(),
    })
    resolved = next

    await resubscribe(loaded.tree, next)
    void fetchMissingIcons(loaded.tree)
    return { tree: loaded.tree, resolved: next, revision: loaded.revision }
  }

  async function current(): Promise<{ tree: ConfigTree; resolved: Resolved; revision: string }> {
    return tree !== null && resolved !== null ? { tree, resolved, revision } : rebuild()
  }

  // Runs behind the render: the page shows initials until icons land, then a rebuild and publish
  // follow. One pass at a time so a burst of edits does not start a burst of fetches.
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

  // Re-registers every fetch the config needs; a surviving widget keeps its cached projection
  // because its key is unchanged.
  async function resubscribe(current: ConfigTree, built: Resolved): Promise<void> {
    for (const release of releases) release()
    releases = []

    const vault = await loadSecrets(env.secretsDir)
    const live = new Set<string>()

    for (const widget of built.widgets) {
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
                  allowLoopback: isLoopbackHost(source.target.base.host),
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
   * One upstream fetch a widget needs. The key derives from what is requested, not from the
   * widget, so two widgets on the same target share one fetch.
   */
  type WidgetSource = {
    readonly key: string
    readonly target: Target
    readonly origin: string
  } & (
    | { readonly kind: SourceKind }
    | { readonly manifest: SingleManifest; readonly operation: string }
  )

  function widgetSources(
    widget: ResolvedWidget,
    manifest: Manifest,
    current: ConfigTree,
  ): WidgetSource[] {
    const sources: WidgetSource[] = []

    const bind = (target: Target) => {
      const origin = `${target.base.scheme}://${target.base.host}:${target.base.port}`
      return { origin, revision: `${origin}${target.base.basePath}` }
    }

    if (isComposite(manifest)) {
      for (const [roleName, role] of Object.entries(manifest.roles)) {
        for (const targetId of widget.bindings[roleName] ?? []) {
          const target = current.targets.get(targetId)
          if (target === undefined) continue
          // The target's type decides the source kind, so a manifest cannot name a path for a
          // service it was not given.
          const kind = role.kinds[target.widgetType]
          if (kind === undefined) continue
          const { origin, revision } = bind(target)
          sources.push({
            key: fetchKey({
              targetId: target.id,
              targetRevision: revision,
              // Includes the manifest id: two composites over the same upstream project
              // different items from it.
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
  function widgetKeys(widget: ResolvedWidget): string[] {
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
      const loadedCatalog = await loadCatalogDirectory(options.catalogDir ?? env.catalogDir)
      catalog = loadedCatalog.manifests
      for (const rejected of loadedCatalog.rejected) {
        console.warn(`catalog: skipped ${rejected.slug} — ${rejected.reason}`)
      }
      await rebuild()
    },

    state() {
      return current()
    },

    /** Callers name a widget, never a URL; the server resolves it to fetch keys. */
    async refreshWidget(widgetId: string) {
      const widget = (await current()).resolved.widgets.find(
        (candidate) => candidate.id === widgetId,
      )
      if (widget === undefined) return false
      const keys = widgetKeys(widget)
      if (keys.length === 0) return false
      await Promise.all(keys.map((key) => scheduler.refreshNow(key)))
      return true
    },

    catalog() {
      return catalog
    },

    /**
     * The only writer of the secrets directory; the write API stores values here and puts a
     * `$secret` reference in the tree.
     */
    async writeSecrets(values) {
      // Unreadable on a fresh install.
      const existing = (await readSecretsFile(env.secretsDir)) ?? {}
      await writeFileDurable(
        secretsPath,
        `${JSON.stringify({ ...existing, ...values }, null, 2)}\n`,
        { mode: 0o600 },
      )
    },

    async deleteSecrets(names) {
      const existing = await readSecretsFile(env.secretsDir)
      if (existing === null) return
      for (const name of names) delete existing[name]
      await writeFileDurable(secretsPath, `${JSON.stringify(existing, null, 2)}\n`, {
        mode: 0o600,
      })
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
        // Omitted until a binding answers so the client shows its loading state, as for a
        // single-source widget before its first fetch.
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
     * Whether the config on disk or the app bundle is ahead of the served generation; drives the
     * editor's badge.
     */
    async pending() {
      await current()
      const generation = await generations.current()
      if (generation === null) return { pending: true, generation: null, revision }
      const meta = await generations.meta(generation)
      // An upgrade changes bundle filenames with the same config; missing it leaves the published
      // page loading a script the new build deleted.
      const assetsHash = assetsFingerprint(await currentAssetTags(options.webDistDir))
      return {
        pending:
          meta === null || meta.configRevision !== revision || meta.assetsHash !== assetsHash,
        generation,
        revision,
      }
    },

    /** Returns null in manual mode; in auto mode debounces so a burst of edits renders once. */
    async requestPublish(actor: string, requestedMode: PublishMode = mode) {
      if (requestedMode === 'manual') return null
      // One promise per debounce window, shared by every caller in it; the last actor wins.
      if (debounce !== null) {
        clearNodeTimeout(debounce.timer)
        debounce.timer = setNodeTimeout(debounce.fire, debounceMs)
        debounce.actor = actor
        return debounce.result
      }
      let fire: () => void = () => {}
      const armed = new Promise<void>((settle) => {
        fire = settle
      })
      const result = armed.then(() => {
        const latest = debounce?.actor ?? actor
        debounce = null
        return context.publishNow(latest)
      })
      debounce = { timer: setNodeTimeout(fire, debounceMs), fire, actor, result }
      return result
    },

    async publishNow(actor: string, label?: string) {
      // Serialises publishes: concurrent ones would race for the generation number and pointer.
      if (publishing !== null) return publishing
      publishing = (async () => {
        const built = await rebuild()
        watcher.expect(built.revision)
        const result = await publish({
          resolved: built.resolved,
          stateDir: env.stateDir,
          configDir: env.configDir,
          configRevision: built.revision,
          actor,
          ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
          ...(label === undefined ? {} : { label }),
        })
        await generations.prune(10)
        hub.broadcast({
          type: 'published',
          data: { generation: result.generation, revision: built.revision },
        })
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
      if (debounce !== null) clearNodeTimeout(debounce.timer)
    },
  }

  // A key update fans out to every widget reading it, re-composed so the browser receives
  // finished widget state rather than a fragment.
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
