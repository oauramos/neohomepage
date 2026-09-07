import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Manifest } from '@neohomepage/catalog-schema'
import type { AppContext } from '../context.ts'
import { layoutFileSchema, targetSchema, widgetSchema } from '../config/schema.ts'
import { ConfigConflictError, ConfigInvalidError } from '../store/configstore.ts'
import { fanOut, normaliseLayout, withinMaxRows } from '../../shared/placement.ts'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import { manifestView } from '../../shared/manifest-view.ts'
import { routeValues, targetShapeFields } from '../../shared/target-shape.ts'
import { probe } from '../fetcher/probe.ts'
import { loadSecrets } from '../secrets/vault.ts'
import { env } from '../env.ts'

/**
 * The write API.
 *
 * Everything here funnels into one `ConfigStore.transaction()`, which validates the whole
 * prospective tree before a byte reaches disk. A caller that cares about losing a concurrent edit
 * sends `If-Match`; a caller that does not gets last-write-wins, which is the right default for a
 * single admin clicking around.
 *
 * No endpoint accepts a URL, a path, a header or a method. A widget is named by id, a target by
 * host and port, and the request that eventually leaves the box is derived from a manifest.
 */

export type ApiOptions = {
  readonly context: AppContext
  readonly catalog: () => ReadonlyMap<string, Manifest>
}

function ifMatch(header: string | undefined): { baseRevision?: string } {
  return header === undefined || header === '*' ? {} : { baseRevision: header.replaceAll('"', '') }
}

/** A short, CSS-safe, collision-resistant id. Prefixed so it can never be numeric-like. */
function newId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

export function createApiRoutes(options: ApiOptions): Hono {
  const api = new Hono()
  const { context } = options

  /** Turn a store error into the status a client can act on. */
  const handle = async <T>(work: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await work() }
    } catch (error) {
      if (error instanceof ConfigConflictError) {
        return { ok: false as const, status: 409 as const, message: error.message }
      }
      if (error instanceof ConfigInvalidError) {
        return { ok: false as const, status: 422 as const, message: error.message }
      }
      throw error
    }
  }

  api.get('/catalog', (c) => {
    const manifests = [...options.catalog().values()].map((manifest) => {
      const view = manifestView(manifest)
      return {
        id: view.id,
        displayName: view.displayName,
        category: view.category,
        icon: view.icon,
        version: view.version,
        template: view.template,
        shape: view.shape,
        operations: view.operations,
        needsCredential: view.needsCredential,
        someKindsNeedNoCredential: view.someKindsNeedNoCredential,
      }
    })
    return c.json({ manifests })
  })

  /**
   * The form the editor renders for a widget type.
   *
   * Derived from the manifest rather than hand-written per widget: the same declaration validates
   * the file on disk, types the MCP tool and generates this. A secret field is described but its
   * value is never returned — see the write-only rule below.
   */
  api.get('/catalog/:id/schema', (c) => {
    const manifest = options.catalog().get(c.req.param('id'))
    if (manifest === undefined) return c.json({ error: 'unknown widget type' }, 404)
    return c.json(manifestView(manifest))
  })

  /**
   * Create a widget and place it.
   *
   * Placement uses the same first-fit code the MCP tools call, so a widget an agent adds lands
   * where a hand-added one would. A refusal from `maxRows` is a 409 with the reason, not a
   * silently truncated board.
   */
  api.post('/widgets', async (c) => {
    const body = (await c.req.json()) as {
      page?: string
      type?: string
      title?: string | null
      targetId?: string | null
      /** Composite widgets: role name -> the targets bound to it. */
      bindings?: Record<string, string[]>
      config?: Record<string, unknown>
      size?: { w?: number; h?: number }
    }
    const manifest = body.type === undefined ? undefined : options.catalog().get(body.type)
    if (manifest === undefined) return c.json({ error: 'unknown widget type' }, 400)

    const id = newId('w')
    const refusals: string[] = []

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const pageId = body.page ?? draft.dashboard.defaultPage
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new Error(`no page "${pageId}"`)

          draft.widgets.set(
            id,
            widgetSchema.parse({
              id,
              page: pageId,
              type: manifest.id,
              title: body.title ?? null,
              targetId: body.targetId ?? null,
              bindings: body.bindings ?? {},
              config: body.config ?? {},
              catalogRev: manifest.version,
            }),
          )

          const existing = draft.layouts.get(pageId)
          const authored = page.grid.breakpoints
            .map((breakpoint) => breakpoint.id)
            .filter((breakpointId) => existing?.meta[breakpointId]?.origin !== 'derived')
          const cols = Object.fromEntries(
            page.grid.breakpoints.map((breakpoint) => [breakpoint.id, breakpoint.cols]),
          )

          const { layouts, refused } = fanOut(
            (existing?.layouts ?? {}) as Record<string, LayoutItem[]>,
            authored.length > 0 ? authored : [page.grid.authoritative],
            cols,
            page.grid.maxRows,
            { id, w: body.size?.w ?? 4, h: body.size?.h ?? 3 },
          )
          refusals.push(...refused)

          draft.layouts.set(
            pageId,
            layoutFileSchema.parse({
              page: pageId,
              layouts,
              meta: {
                ...existing?.meta,
                ...Object.fromEntries(
                  authored.map((breakpointId) => [
                    breakpointId,
                    {
                      origin: 'authored',
                      cols: cols[breakpointId] ?? 12,
                      updatedAt: new Date().toISOString(),
                    },
                  ]),
                ),
              },
            }),
          )
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    await context.reload()
    void context.requestPublish('ui')
    return c.json({ id, revision: result.value.revision, refusedBreakpoints: refusals }, 201)
  })

  api.patch('/widgets/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json()) as {
      title?: string | null
      config?: Record<string, unknown>
      targetId?: string | null
      bindings?: Record<string, string[]>
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const widget = draft.widgets.get(id)
          if (widget === undefined) throw new Error(`no widget "${id}"`)
          draft.widgets.set(
            id,
            widgetSchema.parse({
              ...widget,
              ...(body.title === undefined ? {} : { title: body.title }),
              ...(body.targetId === undefined ? {} : { targetId: body.targetId }),
              ...(body.bindings === undefined ? {} : { bindings: body.bindings }),
              // Merge rather than replace: a form that posts one field must not wipe the others.
              ...(body.config === undefined
                ? {}
                : { config: { ...widget.config, ...body.config } }),
            }),
          )
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    await context.reload()
    void context.requestPublish('ui')
    return c.json({ revision: result.value.revision })
  })

  /**
   * Save geometry for one breakpoint.
   *
   * Marked `authored`, because a human dragged it. Derived tiers are regenerated from the
   * authoritative one and must never be written from a resize event — react-grid-layout emits
   * machine-generated layouts on every window change, and persisting those would dirty a
   * git-tracked file every time someone opened the dashboard on a phone.
   */
  api.put('/pages/:id/layout', async (c) => {
    const pageId = c.req.param('id')
    const body = (await c.req.json()) as { breakpoint?: string; items?: LayoutItem[] }
    if (body.breakpoint === undefined || body.items === undefined) {
      return c.json({ error: 'breakpoint and items are required' }, 400)
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new Error(`no page "${pageId}"`)
          const breakpoint = page.grid.breakpoints.find((entry) => entry.id === body.breakpoint)
          if (breakpoint === undefined)
            throw new Error(`no breakpoint "${String(body.breakpoint)}"`)

          const normalised = normaliseLayout(body.items as LayoutItem[], breakpoint.cols)
          if (!withinMaxRows(normalised, page.grid.maxRows)) {
            throw new Error(`layout exceeds the page's ${String(page.grid.maxRows)}-row limit`)
          }

          const existing = draft.layouts.get(pageId)
          draft.layouts.set(
            pageId,
            layoutFileSchema.parse({
              page: pageId,
              layouts: { ...existing?.layouts, [breakpoint.id]: normalised },
              meta: {
                ...existing?.meta,
                [breakpoint.id]: {
                  origin: 'authored',
                  cols: breakpoint.cols,
                  updatedAt: new Date().toISOString(),
                },
              },
            }),
          )
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    await context.reload()
    void context.requestPublish('ui')
    return c.json({ revision: result.value.revision })
  })

  /**
   * Delete a widget, and everything that only existed for it.
   *
   * Four things outlive a naive delete and each one is invisible until it bites: the layout entry
   * (a ghost in the editor), the target nothing points at any more, the secret that target owned,
   * and the scheduler's poll for a widget that is gone. The last one is the expensive kind of
   * invisible — the app keeps hitting a service for a tile nobody can see.
   */
  api.delete('/widgets/:id', async (c) => {
    const id = c.req.param('id')
    const orphaned: { targets: string[]; secrets: string[] } = { targets: [], secrets: [] }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const widget = draft.widgets.get(id)
          if (widget === undefined) throw new Error(`no widget "${id}"`)
          draft.widgets.delete(id)

          for (const [pageId, layout] of draft.layouts) {
            const layouts = Object.fromEntries(
              Object.entries(layout.layouts).map(([breakpoint, items]) => [
                breakpoint,
                items.filter((entry) => entry.i !== id),
              ]),
            )
            draft.layouts.set(pageId, layoutFileSchema.parse({ ...layout, layouts }))
          }

          // A target with no widgets left is dead weight, and leaving it means its credential
          // stays on disk for a service nobody displays. Every target the widget referenced is
          // considered — a composite binds several, and cleaning up only `targetId` would leave a
          // deleted calendar's four API keys behind.
          const referenced = (candidate: {
            targetId: string | null
            bindings: Record<string, string[]>
          }) =>
            new Set([
              ...(candidate.targetId === null ? [] : [candidate.targetId]),
              ...Object.values(candidate.bindings).flat(),
            ])

          const stillUsed = new Set<string>()
          for (const other of draft.widgets.values()) {
            for (const targetId of referenced(other)) stillUsed.add(targetId)
          }

          for (const targetId of referenced(widget)) {
            if (stillUsed.has(targetId)) continue
            const target = draft.targets.get(targetId)
            if (target === undefined) continue
            orphaned.targets.push(target.id)
            orphaned.secrets.push(...Object.values(target.secrets).map((ref) => ref.$secret))
            draft.targets.delete(target.id)
          }
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    if (orphaned.secrets.length > 0) await context.deleteSecrets(orphaned.secrets)
    // reload() re-derives the scheduler's subscriptions, which is what actually stops the poll.
    await context.reload()
    void context.requestPublish('ui')
    return c.json({ revision: result.value.revision, orphaned })
  })

  api.post('/targets', async (c) => {
    const body = (await c.req.json()) as {
      id?: string
      label?: string
      widgetType?: string
      base?: { scheme?: string; host?: string; port?: number; basePath?: string }
      /** Everything the manifest declares, in one bag. The SERVER decides what is a credential. */
      values?: Record<string, unknown>
      fields?: Record<string, string | number | boolean>
      secrets?: Record<string, string>
    }
    if (body.label === undefined || body.base?.host === undefined || body.base.port === undefined) {
      return c.json({ error: 'label, base.host and base.port are required' }, 400)
    }

    const id = body.id ?? newId('t')
    const widgetType = body.widgetType ?? 'custom'

    /**
     * Route values by what the MANIFEST declares, never by which key the caller put them under.
     *
     * `fields` and `secrets` are still accepted so an existing client keeps working, but they are
     * merged and re-split here. A caller that puts an API key in `fields` gets it stored as a
     * secret anyway, because the field's kind is what decides — not the caller's opinion.
     */
    const declared = targetShapeFields(options.catalog(), widgetType)
    const routed = routeValues(declared, {
      ...(body.fields === undefined ? {} : { fields: body.fields }),
      ...(body.secrets === undefined ? {} : { secrets: body.secrets }),
      ...(body.values === undefined ? {} : { values: body.values }),
    })
    const secretNames = Object.keys(routed.secrets)

    // Only the four keys `base` is allowed to have. The whole reason this is picked apart rather
    // than spread is that spreading a caller's object once put a plaintext credential in config.
    const base = {
      ...(body.base.scheme === undefined ? {} : { scheme: body.base.scheme }),
      host: body.base.host,
      port: body.base.port,
      ...(body.base.basePath === undefined ? {} : { basePath: body.base.basePath }),
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const existing = draft.targets.get(id)
          draft.targets.set(
            id,
            targetSchema.parse({
              ...existing,
              id,
              label: body.label,
              widgetType: body.widgetType ?? existing?.widgetType ?? 'custom',
              base: { ...existing?.base, ...base },
              fields: { ...existing?.fields, ...routed.fields },
              // Only the REFERENCE is written to config. The value goes to the secrets directory,
              // which is gitignored — and the split above is what makes "there is no code path
              // that puts it here" a property of the code rather than a claim about it.
              secrets: {
                ...existing?.secrets,
                ...Object.fromEntries(
                  secretNames.map((name) => [name, { $secret: `${id}.${name}` }]),
                ),
              },
            }),
          )
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    if (secretNames.length > 0) {
      await context.writeSecrets(
        Object.fromEntries(
          secretNames.map((name) => [`${id}.${name}`, routed.secrets[name] as string]),
        ),
      )
    }
    await context.reload()
    void context.requestPublish('ui')
    // `ignored` is reported rather than silently dropped: a client sending a field this shape does
    // not declare has a bug, and the quiet version of that is a credential the user thinks is
    // saved and a widget that will never authenticate.
    return c.json(
      {
        id,
        revision: result.value.revision,
        ...(routed.unknown.length > 0 ? { ignored: routed.unknown } : {}),
      },
      201,
    )
  })

  /**
   * Test a target before saving it.
   *
   * Runs server-side against a scratch credential, and returns whether it worked plus how long it
   * took — never the response body. "It answered in 40ms" is what a person needs; the JSON a
   * *arr instance returned is not, and echoing it is how credentials leak into a browser.
   */
  api.post('/targets/test', async (c) => {
    const body = (await c.req.json()) as {
      type?: string
      base?: { scheme?: string; host?: string; port?: number; basePath?: string }
      operation?: string
      /** Composite widgets: which source kind this target is being bound as. */
      kind?: string
      config?: Record<string, unknown>
      fields?: Record<string, string | number | boolean>
      secrets?: Record<string, string>
    }
    const manifest = body.type === undefined ? undefined : options.catalog().get(body.type)
    if (manifest === undefined) return c.json({ error: 'unknown widget type' }, 400)
    if (body.base?.host === undefined || body.base.port === undefined) {
      return c.json({ error: 'base.host and base.port are required' }, 400)
    }

    const startedAt = performance.now()
    const outcome = await probe({
      manifest,
      operation: body.operation,
      kind: body.kind,
      target: {
        origin: `${body.base.scheme ?? 'http'}://${body.base.host}:${body.base.port}`,
        basePath: body.base.basePath ?? '',
        allowLoopback: body.base.host === '127.0.0.1' || body.base.host === 'localhost',
      },
      config: body.config ?? {},
      auth: { secrets: body.secrets ?? {}, config: body.fields ?? {} },
      now: new Date().toISOString(),
    })
    const durationMs = Math.round(performance.now() - startedAt)

    return outcome.ok
      ? c.json({ ok: true, durationMs })
      : c.json({ ok: false, code: outcome.code, message: outcome.message, durationMs })
  })

  api.get('/secrets', async (c) => {
    // Names and whether each is set. Never a value, never a length — a length is a meaningful
    // clue about a credential and there is no reason for a browser to have it.
    const vault = await loadSecrets(env.secretsDir)
    const { resolved } = await context.state()
    const names = new Set<string>()
    for (const target of resolved.targets) void target
    for (const name of vault.names()) names.add(name)
    return c.json({ secrets: [...names].sort().map((name) => ({ name, set: true })) })
  })

  return api
}
