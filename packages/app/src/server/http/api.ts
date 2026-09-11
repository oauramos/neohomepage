import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../context.ts'
import {
  dashboardSchema,
  pageSchema,
  targetSchema,
  themeSchema,
  widgetSchema,
} from '../config/schema.ts'
import { currentSize, placeWidget, removeFromLayouts, saveSectionLayout } from '../config/board.ts'
import { effectiveSections, sectionOf } from '../config/sections.ts'
import { ConfigConflictError, ConfigInvalidError } from '../store/configstore.ts'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import { manifestView } from '../../shared/manifest-view.ts'
import { routeValues, targetShapeFields } from '../../shared/target-shape.ts'
import { isLoopbackHost } from '../fetcher/policy.ts'
import { probe } from '../fetcher/probe.ts'
import { loadSecrets } from '../secrets/vault.ts'
import { env } from '../env.ts'

/**
 * The write API: every mutation goes through one `ConfigStore.transaction()`, which validates the
 * whole tree before writing (`If-Match` opts into conflict detection, otherwise last-write-wins).
 * No endpoint accepts a URL, path, header or method; the outgoing request is derived from a manifest.
 */

export type ApiOptions = {
  readonly context: AppContext
}

function ifMatch(header: string | undefined): { baseRevision?: string } {
  return header === undefined || header === '*' ? {} : { baseRevision: header.replaceAll('"', '') }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** A short, CSS-safe, collision-resistant id. Prefixed so it can never be numeric-like. */
function newId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

export function createApiRoutes(options: ApiOptions): Hono {
  const api = new Hono()
  const { context } = options

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
      if (error instanceof NotFoundError) {
        return { ok: false as const, status: 404 as const, message: error.message }
      }
      throw error
    }
  }

  api.get('/catalog', (c) => {
    const manifests = [...context.catalog().values()].map((manifest) => {
      const view = manifestView(manifest)
      return {
        id: view.id,
        displayName: view.displayName,
        category: view.category,
        kind: view.kind,
        icon: view.icon,
        iconUrl: context.icons().fileFor(view.icon) === null ? null : `/assets/icons/${view.icon}`,
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
   * Editor form for a widget type, derived from its manifest; secret fields are described, never
   * returned.
   */
  api.get('/catalog/:id/schema', (c) => {
    const manifest = context.catalog().get(c.req.param('id'))
    if (manifest === undefined) return c.json({ error: 'unknown widget type' }, 404)
    return c.json(manifestView(manifest))
  })

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
      /** Which grid section to land in; absent means the page's first one. */
      section?: string | null
    }
    const manifest = body.type === undefined ? undefined : context.catalog().get(body.type)
    if (manifest === undefined) return c.json({ error: 'unknown widget type' }, 400)

    const id = newId('w')
    const refusals: string[] = []

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const pageId = body.page ?? draft.dashboard.defaultPage
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new NotFoundError(`no page "${pageId}"`)

          const widget = widgetSchema.parse({
            id,
            page: pageId,
            type: manifest.id,
            title: body.title ?? null,
            section: body.section ?? null,
            targetId: body.targetId ?? null,
            bindings: body.bindings ?? {},
            config: body.config ?? {},
            catalogRev: manifest.version,
          })
          draft.widgets.set(id, widget)
          refusals.push(
            ...placeWidget(draft, page, widget, { w: body.size?.w ?? 4, h: body.size?.h ?? 3 }),
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
      /** Move to another grid section of the same page; the tile is re-placed there. */
      section?: string | null
      /** How readings are drawn on this tile; merged, so one control can post one key. */
      look?: { stats?: 'inherit' | 'plain' | 'boxed'; align?: 'inherit' | 'start' | 'center' }
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const widget = draft.widgets.get(id)
          if (widget === undefined) throw new NotFoundError(`no widget "${id}"`)
          const page = draft.pages.get(widget.page)
          if (page === undefined) throw new NotFoundError(`no page "${widget.page}"`)
          const updated = widgetSchema.parse({
            ...widget,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.section === undefined ? {} : { section: body.section }),
            ...(body.look === undefined ? {} : { look: { ...widget.look, ...body.look } }),
            ...(body.targetId === undefined ? {} : { targetId: body.targetId }),
            ...(body.bindings === undefined ? {} : { bindings: body.bindings }),
            // Merged so a form can post a single field.
            ...(body.config === undefined ? {} : { config: { ...widget.config, ...body.config } }),
          })
          draft.widgets.set(id, updated)

          // A moved tile keeps its size and is re-placed by first-fit; its old coordinates belong
          // to another section's board.
          if (body.section !== undefined && sectionOf(widget, page) !== sectionOf(updated, page)) {
            const refused = placeWidget(draft, page, updated, currentSize(draft, page, id))
            if (refused.length > 0) {
              throw new ConfigInvalidError([
                {
                  path: `layouts/${page.id}.json`,
                  message: `section "${String(updated.section)}" has no room for this widget (${refused.join(', ')})`,
                },
              ])
            }
          }
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    await context.reload()
    void context.requestPublish('ui')
    return c.json({ revision: result.value.revision })
  })

  /** `features` merges so a panel can flip one toggle without resending the rest. */
  api.patch('/dashboard', async (c) => {
    const body = (await c.req.json()) as {
      title?: string
      features?: { autoHideControls?: boolean; autoHideDelayMs?: number }
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          draft.dashboard = dashboardSchema.parse({
            ...draft.dashboard,
            ...(body.title === undefined ? {} : { title: body.title }),
            features: { ...draft.dashboard.features, ...body.features },
          })
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
   * `cssVars` merges per bucket; `null` for a token deletes the override. Values are not
   * interpreted: they become custom properties on `:root`, and `themeSchema` caps their length.
   */
  api.patch('/theme', async (c) => {
    const body = (await c.req.json()) as {
      mode?: 'light' | 'dark' | 'system'
      preset?: string
      cssVars?: Partial<Record<'theme' | 'light' | 'dark', Record<string, string | null>>>
      surface?: { background?: string | null; blur?: number; overlayOpacity?: number }
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const current = draft.theme
          const mergeBucket = (bucket: 'theme' | 'light' | 'dark'): Record<string, string> => {
            const merged = { ...current.cssVars[bucket] }
            for (const [token, value] of Object.entries(body.cssVars?.[bucket] ?? {})) {
              if (value === null) delete merged[token]
              else merged[token] = value
            }
            return merged
          }
          const cssVars = {
            theme: mergeBucket('theme'),
            light: mergeBucket('light'),
            dark: mergeBucket('dark'),
          }

          draft.theme = themeSchema.parse({
            ...current,
            ...(body.mode === undefined ? {} : { mode: body.mode }),
            ...(body.preset === undefined ? {} : { preset: body.preset }),
            cssVars,
            surface: { ...current.surface, ...body.surface },
          })
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
   * The sparse stored page for editing, not the dense resolved one; only the implicit
   * navbar-and-grid pair is materialised when the page declares no sections.
   */
  api.get('/pages/:id', async (c) => {
    const { tree } = await context.state()
    const page = tree.pages.get(c.req.param('id'))
    if (page === undefined) return c.json({ error: 'unknown page' }, 404)
    return c.json({
      id: page.id,
      title: page.title,
      sections: effectiveSections(page),
      breakpoints: page.grid.breakpoints.map((breakpoint) => ({
        id: breakpoint.id,
        cols: breakpoint.cols,
        minWidth: breakpoint.minWidth,
      })),
      maxRows: page.grid.maxRows,
    })
  })

  /**
   * Sections are replaced whole because they are an ordered list; tree validation in the
   * transaction refuses a list that would strand a widget.
   */
  api.patch('/pages/:id', async (c) => {
    const pageId = c.req.param('id')
    const body = (await c.req.json()) as { title?: string; sections?: unknown[] }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new NotFoundError(`no page "${pageId}"`)
          const parsed = pageSchema.safeParse({
            ...page,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.sections === undefined ? {} : { sections: body.sections }),
          })
          if (!parsed.success) {
            throw new ConfigInvalidError([
              { path: `pages/${pageId}.json`, message: z.prettifyError(parsed.error) },
            ])
          }
          draft.pages.set(pageId, parsed.data)
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
   * Marks the breakpoint `authored`; derived tiers are regenerated from it and must never be
   * saved from a resize event, since react-grid-layout emits layouts on every window change.
   */
  api.put('/pages/:id/layout', async (c) => {
    const pageId = c.req.param('id')
    const body = (await c.req.json()) as {
      breakpoint?: string
      /** The grid section these items belong to; absent means the page's first one. */
      section?: string
      items?: LayoutItem[]
    }
    const { breakpoint, section, items } = body
    if (breakpoint === undefined || items === undefined) {
      return c.json({ error: 'breakpoint and items are required' }, 400)
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new NotFoundError(`no page "${pageId}"`)
          saveSectionLayout(draft, page, section, breakpoint, items)
        },
        ifMatch(c.req.header('if-match')),
      ),
    )

    if (!result.ok) return c.json({ error: result.message }, result.status)
    await context.reload()
    void context.requestPublish('ui')
    return c.json({ revision: result.value.revision })
  })

  /** Deletes a widget with its layout entries, now-unreferenced targets and their secrets. */
  api.delete('/widgets/:id', async (c) => {
    const id = c.req.param('id')
    const orphaned: { targets: string[]; secrets: string[] } = { targets: [], secrets: [] }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const widget = draft.widgets.get(id)
          if (widget === undefined) throw new NotFoundError(`no widget "${id}"`)
          draft.widgets.delete(id)

          removeFromLayouts(draft, id)

          // Composite widgets bind several targets, so every reference is considered, not just
          // `targetId`.
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
    // reload() re-derives the scheduler's subscriptions, which is what stops the poll.
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
      /** All manifest-declared values; the server decides which are credentials. */
      values?: Record<string, unknown>
      fields?: Record<string, string | number | boolean>
      secrets?: Record<string, string>
    }
    if (body.label === undefined || body.base?.host === undefined || body.base.port === undefined) {
      return c.json({ error: 'label, base.host and base.port are required' }, 400)
    }

    const id = body.id ?? newId('t')
    const widgetType = body.widgetType ?? 'custom'

    // Values are routed by the manifest's field kinds, not by the key the caller used; `fields`
    // and `secrets` stay accepted for older clients and are re-split here.
    const declared = targetShapeFields(context.catalog(), widgetType)
    const routed = routeValues(declared, {
      ...(body.fields === undefined ? {} : { fields: body.fields }),
      ...(body.secrets === undefined ? {} : { secrets: body.secrets }),
      ...(body.values === undefined ? {} : { values: body.values }),
    })
    const secretNames = Object.keys(routed.secrets)

    // Picked apart rather than spread: spreading the caller's object once put a plaintext
    // credential in config.
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
              // Only the reference is written to config; the value goes to the gitignored secrets
              // directory.
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
    // Unknown fields are reported so a client bug does not look like a saved credential.
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
   * Probes a target server-side and returns only success and duration, never the response body,
   * which could leak credentials.
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
    const manifest = body.type === undefined ? undefined : context.catalog().get(body.type)
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
        allowLoopback: isLoopbackHost(body.base.host),
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
    // Names and whether each is set; never a value or a length. Asked name by name from config,
    // because the vault's resolved set is empty in a fresh process.
    const vault = await loadSecrets(env.secretsDir)
    const { resolved } = await context.state()
    const secrets = resolved.targets
      .flatMap((target) =>
        Object.entries(target.secretRefs).map(([field, name]) => ({
          name,
          field,
          targetId: target.id,
          set: vault.has(name),
        })),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'en-US'))
    return c.json({ secrets })
  })

  return api
}
