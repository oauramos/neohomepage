import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AppContext } from '../context.ts'
import {
  bookmarkLinkSchema,
  layoutFileSchema,
  pageSchema,
  sectionSchema,
  targetSchema,
  widgetSchema,
} from '../config/schema.ts'
import { currentSize, placeWidget, saveSectionLayout } from '../config/board.ts'
import { effectiveSections, sectionOf } from '../config/sections.ts'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import { probe } from '../fetcher/probe.ts'
import { manifestView } from '../../shared/manifest-view.ts'
import { routeValues, targetShapeFields } from '../../shared/target-shape.ts'
import { DESIGN_TOOL_NAMES, registerDesignTools } from './design.ts'

/**
 * The MCP surface.
 *
 * Seventeen semantic tools, fixed regardless of how large the catalog grows. One tool per widget type
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
 *   - No tool AUTHORS CSS or JavaScript, because prompt injection reaching a write tool is a real
 *     amplifier and that is the one sink that turns it into code execution. The design tools in
 *     `design.ts` change how the board looks, and every value they write is a member of a closed
 *     table this repository ships, a number in a range, or a colour parsed and re-emitted here.
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
        'Start here: the revision it returns is what a later write should pass as baseRevision. ' +
        'It says nothing about how the board LOOKS — describe_theme is where colour, shape and ' +
        'background live.',
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
          // Top to bottom, as the page shows them. A grid section is where add_widget can land;
          // a bookmarks section is what add_bookmark fills.
          sections: page.sections.map((section) =>
            section.kind === 'grid'
              ? {
                  id: section.id,
                  kind: section.kind,
                  title: section.title,
                  columns: Object.fromEntries(section.grid.breakpoints.map((b) => [b.id, b.cols])),
                  maxRows: section.grid.maxRows,
                  widgets: section.widgetIds,
                }
              : section.kind === 'bookmarks'
                ? {
                    id: section.id,
                    kind: section.kind,
                    title: section.title,
                    display: section.display,
                    groups: section.groups.map((group) => ({
                      id: group.id,
                      title: group.title,
                      links: group.links.length,
                    })),
                  }
                : {
                    id: section.id,
                    kind: section.kind,
                    items: section.items.map((item) => item.kind),
                  },
          ),
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
        /** A grid section id from describe_dashboard; absent means the page's first grid. */
        section: z.string().max(64).optional(),
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

            const widget = widgetSchema.parse({
              id,
              page: pageId,
              type: manifest.id,
              title: input.title ?? null,
              section: input.section ?? null,
              targetId: input.targetId ?? null,
              bindings: input.bindings ?? {},
              config: input.config ?? {},
              catalogRev: manifest.version,
            })
            draft.widgets.set(id, widget)
            refused.push(
              ...placeWidget(draft, page, widget, {
                w: input.width ?? 4,
                h: input.height ?? 3,
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
      description:
        'Change a widget’s title or options, or move it to another grid section of its page. ' +
        'Config is merged, not replaced. A moved widget keeps its size and is placed first-fit.',
      inputSchema: {
        id: z.string().max(64),
        title: z.string().max(64).nullable().optional(),
        config: z
          .record(z.string().max(32), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        section: z.string().max(64).optional(),
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
            const page = draft.pages.get(widget.page)
            if (page === undefined) throw new Error(`no page "${widget.page}"`)
            const updated = widgetSchema.parse({
              ...widget,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.section === undefined ? {} : { section: input.section }),
              ...(input.config === undefined
                ? {}
                : { config: { ...widget.config, ...input.config } }),
            })
            draft.widgets.set(input.id, updated)
            if (
              input.section !== undefined &&
              sectionOf(widget, page) !== sectionOf(updated, page)
            ) {
              const refused = placeWidget(draft, page, updated, currentSize(draft, page, input.id))
              if (refused.length > 0) {
                throw new Error(`section "${input.section}" has no room (${refused.join(', ')})`)
              }
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
        'Set the geometry of one grid section for one breakpoint. Coordinates are grid units from ' +
        'the section’s own top-left. The layout is clamped to the section’s column count and ' +
        'refused if it exceeds its row limit. Omit section for the page’s first grid.',
      inputSchema: {
        page: z.string().max(64),
        section: z.string().max(64).optional(),
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
            saveSectionLayout(
              draft,
              page,
              input.section,
              input.breakpoint,
              input.items as LayoutItem[],
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
    'set_sections',
    {
      title: 'Set a page’s sections',
      description:
        'Replace a page’s sections whole, top to bottom. Kinds: navbar (items: title, text, ' +
        'links, clock, search, spacer), grid (a board of widgets, with its own cols per breakpoint ' +
        'and maxRows), bookmarks (groups of links; columns per breakpoint; display list, cards, ' +
        'icons or chips). A link is scheme, host, port and path — never a URL. Read the current ' +
        'list with get_sections first: a grid section that disappears while widgets still name ' +
        'it is refused, and ids are how the editor finds things.',
      inputSchema: {
        page: z.string().max(64),
        sections: z.array(sectionSchema).max(24),
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
            draft.pages.set(input.page, pageSchema.parse({ ...page, sections: input.sections }))
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
    'get_sections',
    {
      title: 'Get a page’s sections',
      description:
        'The page’s sections as stored — what was set, blanks where the page defaults apply — ' +
        'in the shape set_sections accepts. A page that never declared any returns the implicit ' +
        'pair: a navbar carrying the title over one grid.',
      annotations: { readOnlyHint: true },
      inputSchema: { page: z.string().max(64).optional() },
    },
    async (input) => {
      const { tree } = await context.state()
      const pageId = input.page ?? tree.dashboard.defaultPage
      const page = tree.pages.get(pageId)
      if (page === undefined) return fail(`no page "${pageId}"`)
      return ok({ page: pageId, sections: effectiveSections(page) })
    },
  )

  server.registerTool(
    'add_bookmark',
    {
      title: 'Add a bookmark',
      description:
        'Add one link to a group in a bookmarks section, creating the group by title if it does ' +
        'not exist. The destination is host and port (and scheme, and a path), never a URL. ' +
        'Icon is a dashboard-icons slug such as "nextcloud"; it is fetched and cached by the ' +
        'server. Use set_sections to reorder or remove.',
      inputSchema: {
        page: z.string().max(64).optional(),
        section: z.string().max(64),
        group: z.string().max(64),
        label: z.string().min(1).max(64),
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).optional(),
        scheme: z.enum(['http', 'https']).optional(),
        path: z.string().max(200).optional(),
        icon: z.string().max(64).optional(),
        baseRevision: z.string().max(64).optional(),
      },
    },
    async (input) => {
      const linkId = newId('l')
      try {
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            const pageId = input.page ?? draft.dashboard.defaultPage
            const page = draft.pages.get(pageId)
            if (page === undefined) throw new Error(`no page "${pageId}"`)
            const sections = effectiveSections(page).map((section) => structuredClone(section))
            const section = sections.find((candidate) => candidate.id === input.section)
            if (section === undefined || section.kind !== 'bookmarks') {
              throw new Error(`no bookmarks section "${input.section}" on page "${pageId}"`)
            }
            const scheme = input.scheme ?? 'http'
            const link = bookmarkLinkSchema.parse({
              id: linkId,
              label: input.label,
              base: {
                scheme,
                host: input.host,
                port: input.port ?? (scheme === 'https' ? 443 : 80),
              },
              path: input.path ?? '/',
              icon: input.icon ?? null,
            })
            const group =
              section.groups.find((candidate) => candidate.id === input.group) ??
              section.groups.find((candidate) => candidate.title === input.group)
            if (group === undefined) {
              section.groups.push({ id: newId('g'), title: input.group, links: [link] })
            } else {
              group.links.push(link)
            }
            draft.pages.set(pageId, pageSchema.parse({ ...page, sections }))
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        await context.reload()
        void context.requestPublish(deps.actor)
        return ok({ id: linkId, revision: result.revision })
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

  registerDesignTools(server, deps)

  return server
}

/** The tool names this build exposes, asserted against the live listing by the test suite. */
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
  'set_sections',
  'get_sections',
  'add_bookmark',
  'test_target',
  'publish',
  ...DESIGN_TOOL_NAMES,
] as const
