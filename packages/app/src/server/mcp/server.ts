import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AppContext } from '../context.ts'
import { layoutFileSchema, targetSchema, widgetSchema } from '../config/schema.ts'
import { fanOut, normaliseLayout, withinMaxRows } from '../../shared/placement.ts'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import { probe } from '../fetcher/probe.ts'
import { manifestView } from '../../shared/manifest-view.ts'
import { routeValues, targetShapeFields } from '../../shared/target-shape.ts'

/**
 * The MCP surface.
 *
 * Twelve semantic tools, fixed regardless of how large the catalog grows. One tool per widget type
 * was rejected for reasons that are measurable rather than aesthetic: every tool's schema is sent
 * on every request, so the surface is a permanent token tax, and Claude Code flattens root-level
 * anyOf/oneOf — which mangles the obvious discriminated-union-over-widget-types design. Every
 * input here is a flat object; type safety comes from a three-step loop advertised in each
 * mutating tool's description: search_catalog, then get_widget_schema, then add_widget.
 *
 * Three things are permanently absent, and their absence is the design:
 *
 *   - No tool reads a secret, at any scope. Tool results land in a model context that may be
 *     shipped to a third-party API.
 *   - No tool accepts a URL, a path, a header or a method. An agent names a widget or a host and
 *     a port; the request is derived from a manifest, exactly as it is for the browser.
 *   - No tool writes custom CSS or JavaScript, because prompt injection reaching a write tool is
 *     a real amplifier and that is the one sink that turns it into code execution.
 *
 * Every write goes through the same ConfigStore.transaction() the UI uses, lands in the audit log
 * attributed to the token, and cuts a generation — so "the AI rewrote my dashboard" is a rollback,
 * not a support ticket.
 */

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 12)}`
}

export type McpDeps = {
  readonly context: AppContext
  /** Identifies the writer in the audit log, so an agent's edits are attributable. */
  readonly actor: string
}

export function buildDashboardServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'neohomepage', version: '0.1.0' })
  const { context } = deps

  server.registerTool(
    'describe_dashboard',
    {
      title: 'Describe the dashboard',
      description:
        'Pages, widgets, targets, the current revision and whether anything is unpublished. ' +
        'Start here: the revision it returns is what a later write should pass as baseRevision.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const { resolved, revision } = await context.state()
      const pending = await context.pending()
      return ok({
        title: resolved.title,
        revision,
        generation: pending.generation,
        unpublishedChanges: pending.pending,
        pages: resolved.pages.map((page) => ({
          id: page.id,
          title: page.title,
          columns: Object.fromEntries(page.grid.breakpoints.map((b) => [b.id, b.cols])),
          maxRows: page.grid.maxRows,
          widgets: page.widgetIds.length,
        })),
        widgets: resolved.widgets.map((widget) => ({
          id: widget.id,
          title: widget.title,
          type: widget.type,
          targetId: widget.targetId,
          unsupported: widget.unsupported,
        })),
        targets: resolved.targets.map((target) => ({ id: target.id, label: target.label })),
        diagnostics: resolved.diagnostics,
      })
    },
  )

  server.registerTool(
    'search_catalog',
    {
      title: 'Search the widget catalog',
      description:
        'Find a widget type to add. Step one of three: search_catalog, get_widget_schema, add_widget.',
      annotations: { readOnlyHint: true },
      inputSchema: { query: z.string().max(80).optional() },
    },
    ({ query }) => {
      const needle = (query ?? '').toLowerCase()
      const matches = [...context.catalog().values()]
        .filter((manifest) =>
          `${manifest.id} ${manifest.displayName} ${manifest.category}`
            .toLowerCase()
            .includes(needle),
        )
        .map((manifest) => ({
          type: manifest.id,
          displayName: manifest.displayName,
          category: manifest.category,
          needsCredential: manifestView(manifest).needsCredential,
        }))
      return ok({ matches, total: matches.length })
    },
  )

  server.registerTool(
    'get_widget_schema',
    {
      title: 'Describe a widget type',
      description:
        'The fields a widget type needs, so add_widget can be called with valid config. Step two ' +
        'of three. Secret fields are named here; their values are set through add_target and are ' +
        'never readable.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: z.string().max(64) },
    },
    ({ type }) => {
      const manifest = context.catalog().get(type)
      if (manifest === undefined) return fail(`no widget type "${type}" — try search_catalog`)
      const view = manifestView(manifest)
      return ok({
        type: view.id,
        displayName: view.displayName,
        template: view.template,
        shape: view.shape,
        targetFields: view.target?.fields ?? [],
        configFields: view.config,
        operations: view.operations,
        // A composite is bound role by role, so an agent that only learned about `targetId` would
        // create a widget that fetches nothing. Saying so in the schema is what stops that.
        roles: view.roles,
        pollDefaultMs: view.poll.defaultIntervalMs,
      })
    },
  )

  server.registerTool(
    'list_widgets',
    {
      title: 'List widgets',
      description: 'Every widget on the dashboard, with its type, target and current state.',
      annotations: { readOnlyHint: true },
      inputSchema: { page: z.string().max(64).optional() },
    },
    async ({ page }) => {
      const { resolved } = await context.state()
      const data = context.widgetData() as Record<string, { meta?: { state?: string } }>
      return ok({
        widgets: resolved.widgets
          .filter((widget) => page === undefined || widget.page === page)
          .map((widget) => ({
            id: widget.id,
            title: widget.title,
            type: widget.type,
            page: widget.page,
            targetId: widget.targetId,
            state: data[widget.id]?.meta?.state ?? 'pending',
          })),
      })
    },
  )

  server.registerTool(
    'list_targets',
    {
      title: 'List targets',
      description: 'The services widgets point at. Credentials are never included.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const { resolved } = await context.state()
      return ok({
        targets: resolved.targets.map((target) => ({
          id: target.id,
          label: target.label,
          origin: target.origin,
        })),
      })
    },
  )

  server.registerTool(
    'add_target',
    {
      title: 'Add or update a service',
      description:
        'Register a service by host and port. A credential passed here is written to the secrets ' +
        'directory and only a reference is stored in config; it can never be read back, by this ' +
        'tool or any other.',
      inputSchema: {
        label: z.string().min(1).max(64),
        type: z.string().max(64),
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        scheme: z.enum(['http', 'https']).optional(),
        basePath: z.string().max(120).optional(),
        secrets: z.record(z.string().max(32), z.string().max(4096)).optional(),
        /** Non-secret values. Sorted from `secrets` by the manifest, not by which key you used. */
        fields: z
          .record(z.string().max(32), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        baseRevision: z.string().max(64).optional(),
      },
    },
    async (input) => {
      const id = newId('t')
      // Routed by the manifest, like the HTTP path: an agent that puts a credential under the
      // wrong name still gets it stored in the vault rather than in a git-tracked file.
      const routed = routeValues(targetShapeFields(context.catalog(), input.type), {
        ...(input.fields === undefined ? {} : { fields: input.fields }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      })
      const secretNames = Object.keys(routed.secrets)
      try {
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            draft.targets.set(
              id,
              targetSchema.parse({
                id,
                label: input.label,
                widgetType: input.type,
                base: {
                  scheme: input.scheme ?? 'http',
                  host: input.host,
                  port: input.port,
                  basePath: input.basePath ?? '',
                },
                fields: routed.fields,
                secrets: Object.fromEntries(
                  secretNames.map((name) => [name, { $secret: `${id}.${name}` }]),
                ),
              }),
            )
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        if (secretNames.length > 0) {
          await context.writeSecrets(
            Object.fromEntries(
              secretNames.map((name) => [`${id}.${name}`, routed.secrets[name] as string]),
            ),
          )
        }
        await context.reload()
        return ok({
          id,
          revision: result.revision,
          ...(routed.unknown.length > 0 ? { ignored: routed.unknown } : {}),
        })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    'add_widget',
    {
      title: 'Add a widget',
      description:
        'Step three of three. Placement uses the same first-fit code the editor uses, so the ' +
        'widget lands where a person adding it by hand would have put it. If the page has a row ' +
        'limit and no space, this refuses rather than pushing the widget below the fold.',
      inputSchema: {
        type: z.string().max(64),
        page: z.string().max(64).optional(),
        title: z.string().max(64).optional(),
        targetId: z.string().max(64).optional(),
        /**
         * Composite widget types bind targets by ROLE instead of through `targetId`. An agent that
         * only knew about `targetId` would create a calendar bound to nothing and report success,
         * so `get_widget_schema` names the roles and this is where they are filled.
         */
        bindings: z.record(z.string().max(32), z.array(z.string().max(64)).max(16)).optional(),
        config: z
          .record(z.string().max(32), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        width: z.number().int().min(1).max(24).optional(),
        height: z.number().int().min(1).max(24).optional(),
        baseRevision: z.string().max(64).optional(),
      },
    },
    async (input) => {
      const manifest = context.catalog().get(input.type)
      if (manifest === undefined) return fail(`no widget type "${input.type}" — try search_catalog`)

      // Refuse a composite with an unsatisfied role here rather than creating a tile that fetches
      // nothing: the agent gets a message naming the role, not a silently empty widget.
      const view = manifestView(manifest)
      for (const role of view.roles) {
        const bound = input.bindings?.[role.name]?.length ?? 0
        if (bound < role.min) {
          return fail(
            `"${input.type}" needs at least ${role.min} target bound to role "${role.name}" ` +
              `(${role.label}); call get_widget_schema to see which kinds it accepts`,
          )
        }
        if (bound > role.max) {
          return fail(`role "${role.name}" accepts at most ${role.max} targets`)
        }
      }

      const id = newId('w')
      const refused: string[] = []
      try {
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            const pageId = input.page ?? draft.dashboard.defaultPage
            const page = draft.pages.get(pageId)
            if (page === undefined) throw new Error(`no page "${pageId}"`)

            draft.widgets.set(
              id,
              widgetSchema.parse({
                id,
                page: pageId,
                type: manifest.id,
                title: input.title ?? null,
                targetId: input.targetId ?? null,
                bindings: input.bindings ?? {},
                config: input.config ?? {},
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

            const fanned = fanOut(
              (existing?.layouts ?? {}) as Record<string, LayoutItem[]>,
              authored.length > 0 ? authored : [page.grid.authoritative],
              cols,
              page.grid.maxRows,
              { id, w: input.width ?? 4, h: input.height ?? 3 },
            )
            refused.push(...fanned.refused)

            draft.layouts.set(
              pageId,
              layoutFileSchema.parse({
                page: pageId,
                layouts: fanned.layouts,
                meta: {
                  ...existing?.meta,
                  ...Object.fromEntries(
                    authored.map((breakpointId) => [
                      breakpointId,
                      { origin: 'authored', cols: cols[breakpointId] ?? 12 },
                    ]),
                  ),
                },
              }),
            )
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        await context.reload()
        void context.requestPublish(deps.actor)
        return ok({ id, revision: result.revision, refusedBreakpoints: refused })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    'update_widget',
    {
      title: 'Update a widget',
      description: 'Change a widget’s title or options. Config is merged, not replaced.',
      inputSchema: {
        id: z.string().max(64),
        title: z.string().max(64).nullable().optional(),
        config: z
          .record(z.string().max(32), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        baseRevision: z.string().max(64).optional(),
      },
    },
    async (input) => {
      try {
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            const widget = draft.widgets.get(input.id)
            if (widget === undefined) throw new Error(`no widget "${input.id}"`)
            draft.widgets.set(
              input.id,
              widgetSchema.parse({
                ...widget,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.config === undefined
                  ? {}
                  : { config: { ...widget.config, ...input.config } }),
              }),
            )
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        await context.reload()
        void context.requestPublish(deps.actor)
        return ok({ revision: result.revision })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    'remove_widget',
    {
      title: 'Remove a widget',
      description:
        'Delete a widget and its layout entries. Every change cuts a generation, so this is ' +
        'reversible with the generations command.',
      annotations: { destructiveHint: true },
      inputSchema: { id: z.string().max(64), baseRevision: z.string().max(64).optional() },
    },
    async (input) => {
      try {
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            if (!draft.widgets.delete(input.id)) throw new Error(`no widget "${input.id}"`)
            for (const [pageId, layout] of draft.layouts) {
              draft.layouts.set(
                pageId,
                layoutFileSchema.parse({
                  ...layout,
                  layouts: Object.fromEntries(
                    Object.entries(layout.layouts).map(([breakpoint, items]) => [
                      breakpoint,
                      items.filter((entry) => entry.i !== input.id),
                    ]),
                  ),
                }),
              )
            }
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        await context.reload()
        void context.requestPublish(deps.actor)
        return ok({ revision: result.revision })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    'set_layout',
    {
      title: 'Move widgets',
      description:
        'Set the geometry for one breakpoint. Coordinates are grid units. The layout is clamped ' +
        'to the column count and refused if it exceeds the page row limit.',
      inputSchema: {
        page: z.string().max(64),
        breakpoint: z.string().max(32),
        items: z
          .array(
            z.object({
              i: z.string().max(64),
              x: z.number().int().min(0).max(24),
              y: z.number().int().min(0).max(999),
              w: z.number().int().min(1).max(24),
              h: z.number().int().min(1).max(200),
            }),
          )
          .max(200),
        baseRevision: z.string().max(64).optional(),
      },
    },
    async (input) => {
      try {
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            const page = draft.pages.get(input.page)
            if (page === undefined) throw new Error(`no page "${input.page}"`)
            const breakpoint = page.grid.breakpoints.find((entry) => entry.id === input.breakpoint)
            if (breakpoint === undefined) throw new Error(`no breakpoint "${input.breakpoint}"`)

            const normalised = normaliseLayout(input.items as LayoutItem[], breakpoint.cols)
            if (!withinMaxRows(normalised, page.grid.maxRows)) {
              throw new Error(`layout exceeds the page's ${String(page.grid.maxRows)}-row limit`)
            }
            const existing = draft.layouts.get(input.page)
            draft.layouts.set(
              input.page,
              layoutFileSchema.parse({
                page: input.page,
                layouts: { ...existing?.layouts, [breakpoint.id]: normalised },
                meta: {
                  ...existing?.meta,
                  [breakpoint.id]: { origin: 'authored', cols: breakpoint.cols },
                },
              }),
            )
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        await context.reload()
        void context.requestPublish(deps.actor)
        return ok({ revision: result.revision })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )

  server.registerTool(
    'test_target',
    {
      title: 'Test a service',
      description:
        'Check whether a service answers, before or after adding it. Returns whether it worked ' +
        'and how long it took, never the response body.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: z.string().max(64),
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        scheme: z.enum(['http', 'https']).optional(),
        secrets: z.record(z.string().max(32), z.string().max(4096)).optional(),
        kind: z.string().max(64).optional(),
      },
    },
    async (input) => {
      const manifest = context.catalog().get(input.type)
      if (manifest === undefined) return fail(`no widget type "${input.type}"`)

      const startedAt = performance.now()
      const outcome = await probe({
        manifest,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        target: {
          origin: `${input.scheme ?? 'http'}://${input.host}:${input.port}`,
          basePath: '',
          allowLoopback: input.host === '127.0.0.1' || input.host === 'localhost',
        },
        config: {},
        auth: { secrets: input.secrets ?? {}, config: {} },
        now: new Date().toISOString(),
      })
      const durationMs = Math.round(performance.now() - startedAt)
      return outcome.ok
        ? ok({ reachable: true, durationMs })
        : ok({ reachable: false, code: outcome.code, durationMs })
    },
  )

  server.registerTool(
    'publish',
    {
      title: 'Publish the dashboard',
      description:
        'Render the static page from the current config. Same action as the Regenerate button.',
      inputSchema: {},
    },
    async () => {
      const result = await context.publishNow(deps.actor, 'mcp')
      return ok({
        generation: result.generation,
        bytes: result.bytes,
        durationMs: result.durationMs,
      })
    },
  )

  return server
}

/** The tool names this build exposes, for the boot-time self-check and the docs. */
export const TOOL_NAMES = [
  'describe_dashboard',
  'search_catalog',
  'get_widget_schema',
  'list_widgets',
  'list_targets',
  'add_target',
  'add_widget',
  'update_widget',
  'remove_widget',
  'set_layout',
  'test_target',
  'publish',
] as const
