import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Manifest } from '@neohomepage/catalog-schema'
import type { AppContext } from '../context.ts'
import {
  dashboardSchema,
  layoutFileSchema,
  pageSchema,
  targetSchema,
  themeSchema,
  widgetSchema,
} from '../config/schema.ts'
import { currentSize, placeWidget, saveSectionLayout } from '../config/board.ts'
import { effectiveSections, sectionOf } from '../config/sections.ts'
import { ConfigConflictError, ConfigInvalidError } from '../store/configstore.ts'
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
      /** Which grid section to land in; absent means the page's first one. */
      section?: string | null
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

          const widget = widgetSchema.parse({
            id,
            page: pageId,
            type: manifest.id,
            title: body.title ?? null,
            // Stored only when the caller chose: null keeps "first grid section" a default the
            // file does not have to spell out.
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
          if (widget === undefined) throw new Error(`no widget "${id}"`)
          const page = draft.pages.get(widget.page)
          if (page === undefined) throw new Error(`no page "${widget.page}"`)
          const updated = widgetSchema.parse({
            ...widget,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.section === undefined ? {} : { section: body.section }),
            ...(body.look === undefined ? {} : { look: { ...widget.look, ...body.look } }),
            ...(body.targetId === undefined ? {} : { targetId: body.targetId }),
            ...(body.bindings === undefined ? {} : { bindings: body.bindings }),
            // Merge rather than replace: a form that posts one field must not wipe the others.
            ...(body.config === undefined ? {} : { config: { ...widget.config, ...body.config } }),
          })
          draft.widgets.set(id, updated)

          // A move keeps the tile's size and lets first-fit find it a spot in the new section:
          // its old coordinates belong to a board it is no longer on.
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

  /**
   * Dashboard-level settings: the title, and the optional behaviour under `features`.
   *
   * `features` merges rather than replaces, so a panel that flips one toggle does not have to know
   * or resend the others — the same rule the theme route follows, and for the same reason.
   */
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
   * Change the look: preset, scheme, token overrides, background.
   *
   * `cssVars` merges per bucket rather than replacing, so the design panel can send one slider's
   * token without resending the palette — and sending `null` for a token DELETES the override
   * rather than writing the string "null", which is what makes "reset this back to the preset" a
   * thing the UI can express at all.
   *
   * The values themselves are not interpreted here. They are custom properties on `:root`, so the
   * blast radius of a malformed one is a declaration the browser drops; `themeSchema` caps their
   * length, and nothing in this payload can name a URL, a host or a path.
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
          const buckets = ['theme', 'light', 'dark'] as const
          const cssVars = Object.fromEntries(
            buckets.map((bucket) => {
              const merged: Record<string, string> = { ...current.cssVars[bucket] }
              for (const [token, value] of Object.entries(body.cssVars?.[bucket] ?? {})) {
                if (value === null) delete merged[token]
                else merged[token] = value
              }
              return [bucket, merged]
            }),
          ) as Record<'theme' | 'light' | 'dark', Record<string, string>>

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
   * A page as the editor edits it: the stored sections made explicit.
   *
   * The resolved page is dense — every column count filled in, every href composed — which is
   * right for rendering and wrong for editing: a form should show what the user SET and leave the
   * rest blank. So this returns the sparse config, with only the implicit navbar-and-grid pair
   * materialised when the page declares nothing, because that is what the user is about to edit.
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
   * A page's title and its sections, replaced whole.
   *
   * Whole rather than patched because a section list is an ORDER as much as a set, and the editor
   * that reorders, adds and removes in one drag has nothing sensible to say per section. The tree
   * validation behind the transaction is what refuses a list that would strand a widget: a grid
   * section that disappears while tiles still name it is a 422, not a vanished board.
   */
  api.patch('/pages/:id', async (c) => {
    const pageId = c.req.param('id')
    const body = (await c.req.json()) as { title?: string; sections?: unknown[] }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new Error(`no page "${pageId}"`)
          const parsed = pageSchema.safeParse({
            ...page,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.sections === undefined ? {} : { sections: body.sections }),
          })
          if (!parsed.success) {
            // A malformed section list is the caller's mistake, and 422 with the field named is
            // what the editor needs to say so; a bare throw would be a 500 with a stack.
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
   * Save geometry for one breakpoint.
   *
   * Marked `authored`, because a human dragged it. Derived tiers are regenerated from the
   * authoritative one and must never be written from a resize event — react-grid-layout emits
   * machine-generated layouts on every window change, and persisting those would dirty a
   * git-tracked file every time someone opened the dashboard on a phone.
   */
  api.put('/pages/:id/layout', async (c) => {
    const pageId = c.req.param('id')
    const body = (await c.req.json()) as {
      breakpoint?: string
      /** The grid section these items belong to; absent means the page's first one. */
      section?: string
      items?: LayoutItem[]
    }
    if (body.breakpoint === undefined || body.items === undefined) {
      return c.json({ error: 'breakpoint and items are required' }, 400)
    }

    const result = await handle(() =>
      context.store.transaction(
        'ui',
        (draft) => {
          const page = draft.pages.get(pageId)
          if (page === undefined) throw new Error(`no page "${pageId}"`)
          saveSectionLayout(
            draft,
            page,
            body.section,
            body.breakpoint as string,
            body.items as LayoutItem[],
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
    //
    // Asked name by name, from the names config declares. The obvious version — listing what the
    // vault has resolved — returns nothing in a fresh process, which showed up as every saved
    // credential looking unset after a restart.
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
