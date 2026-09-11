import { z } from 'zod'
import { parseIconRef } from '../assets/icons.ts'
import { SEARCH_ENGINES } from '../../shared/links.ts'

/**
 * The on-disk config tree; files store only what differs from the defaults. Every file schema uses
 * `.catchall(z.unknown())` so a rollback to an older release keeps fields a newer one added.
 */

/** Ids are interpolated into CSS selectors and file names, so the shape is constrained at rest. */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'must start with a letter and contain only [A-Za-z0-9_-]')

/** The one place a schema version appears. Per-file versions produce impossible cross-file states. */
export const CURRENT_SCHEMA_VERSION = 1

export const dashboardSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    title: z.string().min(1).max(64).default('neohomepage'),
    defaultPage: idSchema.default('home'),
    /** Single page at v1; the array exists so adding pages later is not a migration. */
    pages: z.array(idSchema).min(1).default(['home']),
    catalog: z
      .object({
        // Served from the docs GitHub Pages site; the pointer file's `movedTo` lets this URL keep
        // answering if the catalog moves.
        url: z.url().default('https://oauramos.github.io/neohomepage/catalog/v1/latest.json'),
        pinnedRelease: z.string().max(64).nullable().default(null),
        autoUpdate: z.boolean().default(true),
      })
      .prefault({}),
    // `autoHideControls` fades the floating buttons when idle; keyboard focus always overrides it.
    features: z
      .object({
        autoHideControls: z.boolean().default(false),
        autoHideDelayMs: z.int().min(1000).max(60000).default(5000),
      })
      .prefault({}),
  })
  .catchall(z.unknown())

export type Dashboard = z.infer<typeof dashboardSchema>

export const breakpointSchema = z
  .object({
    id: idSchema,
    minWidth: z.int().min(0).max(4096),
    cols: z.int().min(1).max(24),
  })
  .catchall(z.unknown())

/**
 * Where a bookmark or navbar link points, as parts: nothing in config, the API or MCP is ever a
 * URL. The server composes one at render time, applying the `targetUrl` opcode's path rules.
 */
export const linkBaseSchema = z
  .object({
    scheme: z.enum(['http', 'https']).default('http'),
    host: z.string().min(1).max(253),
    port: z.int().min(1).max(65535),
  })
  .strict()

export const linkPathSchema = z
  .string()
  .max(200)
  .default('/')
  .refine(
    (value) => /^\/[A-Za-z0-9._~\-/?=&%#+:@!$'()*,;]*$/.test(value),
    'must be an absolute path made of URL characters',
  )
  .refine(
    (value) => !value.includes('..') && !value.includes('//'),
    'must not contain ".." or "//"',
  )

/** Icon name, never a URL: `nextcloud` (dashboard-icons), `si-*` (Simple Icons), `mdi-*` (MDI), optional `-#rrggbb`. */
export const iconSlugSchema = z
  .string()
  .max(90)
  .refine(
    (value) => parseIconRef(value) !== null,
    'must be an icon name such as nextcloud, si-nextcloud or mdi-router-network, optionally -#rrggbb',
  )
  .nullable()
  .default(null)

export const bookmarkLinkSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(64),
    base: linkBaseSchema,
    path: linkPathSchema,
    icon: iconSlugSchema,
  })
  .catchall(z.unknown())

export type BookmarkLink = z.infer<typeof bookmarkLinkSchema>

export const bookmarkGroupSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(64),
    links: z.array(bookmarkLinkSchema).max(64).default([]),
  })
  .catchall(z.unknown())

export type BookmarkGroup = z.infer<typeof bookmarkGroupSchema>

/** Closed set: each display is CSS this build ships. */
export const BOOKMARK_DISPLAYS = ['list', 'cards', 'icons', 'chips'] as const
export type BookmarkDisplay = (typeof BOOKMARK_DISPLAYS)[number]

export const navItemSchema = z.discriminatedUnion('kind', [
  // `boxed` draws the item in a muted box; the search box is already one and the spacer is empty.
  z
    .object({ id: idSchema, kind: z.literal('title'), boxed: z.boolean().default(false) })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('text'),
      text: z.string().min(1).max(120),
      boxed: z.boolean().default(false),
    })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('links'),
      links: z.array(bookmarkLinkSchema).max(24).default([]),
      boxed: z.boolean().default(false),
    })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('clock'),
      showDate: z.boolean().default(true),
      hour12: z.boolean().default(false),
      boxed: z.boolean().default(false),
    })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('search'),
      engine: z.enum(SEARCH_ENGINES).default('duckduckgo'),
      placeholder: z.string().max(64).default('Search'),
    })
    .catchall(z.unknown()),
  z.object({ id: idSchema, kind: z.literal('spacer') }).catchall(z.unknown()),
])

export type NavItem = z.infer<typeof navItemSchema>

/**
 * Per-breakpoint records (`cols`, `columns`) are sparse: an absent key falls back to the page's
 * grid for a grid section and to a built-in default for bookmarks.
 */
export const sectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: idSchema,
      kind: z.literal('navbar'),
      title: z.string().max(64).nullable().default(null),
      items: z.array(navItemSchema).max(12).default([]),
    })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('grid'),
      title: z.string().max(64).nullable().default(null),
      cols: z.record(idSchema, z.int().min(1).max(24)).default({}),
      maxRows: z.int().min(1).max(200).nullable().default(null),
    })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('bookmarks'),
      title: z.string().max(64).nullable().default(null),
      columns: z.record(idSchema, z.int().min(1).max(12)).default({}),
      display: z.enum(BOOKMARK_DISPLAYS).default('list'),
      groups: z.array(bookmarkGroupSchema).max(32).default([]),
    })
    .catchall(z.unknown()),
])

export type Section = z.infer<typeof sectionSchema>

export const pageSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(64).default('Home'),
    icon: z.string().max(64).nullable().default(null),
    // Empty means the pre-sections default (title header over one grid), synthesised by the
    // resolver so files on disk need no migration.
    sections: z.array(sectionSchema).max(24).default([]),
    grid: z
      .object({
        rowHeight: z.int().min(16).max(400).default(56),
        margin: z.tuple([z.int().min(0).max(64), z.int().min(0).max(64)]).default([12, 12]),
        containerPadding: z
          .tuple([z.int().min(0).max(64), z.int().min(0).max(64)])
          .default([16, 16]),
        // When set, the auto-placer refuses a full grid instead of pushing a widget below the fold.
        maxRows: z.int().min(1).max(200).nullable().default(null),
        breakpoints: z
          .array(breakpointSchema)
          .min(1)
          .max(6)
          .default([
            { id: 'sm', minWidth: 0, cols: 2 },
            { id: 'md', minWidth: 768, cols: 6 },
            { id: 'lg', minWidth: 1200, cols: 12 },
          ]),
        /** The tier a human authors; the others are derived from it until someone drags there. */
        authoritative: idSchema.default('lg'),
      })
      .prefault({}),
  })
  .catchall(z.unknown())

export type Page = z.infer<typeof pageSchema>

export const layoutItemSchema = z
  .object({
    i: idSchema,
    x: z.int().min(0).max(24),
    y: z.int().min(0).max(999),
    w: z.int().min(1).max(24),
    h: z.int().min(1).max(200),
  })
  .catchall(z.unknown())

export const layoutFileSchema = z
  .object({
    page: idSchema,
    layouts: z.record(idSchema, z.array(layoutItemSchema)).default({}),
    // `derived` layouts are regenerated from the authoritative tier, not persisted, so
    // react-grid-layout's per-resize output does not dirty a git-tracked file.
    meta: z
      .record(
        idSchema,
        z
          .object({
            origin: z.enum(['authored', 'derived']),
            cols: z.int().min(1).max(24),
            updatedAt: z.iso.datetime().optional(),
          })
          .catchall(z.unknown()),
      )
      .prefault({}),
  })
  .catchall(z.unknown())

export type LayoutFile = z.infer<typeof layoutFileSchema>

/** A reference to a secret. Never the value: the writer has no path that puts one in config/. */
export const secretRefSchema = z.object({ $secret: z.string().regex(/^[a-z][A-Za-z0-9.]{0,63}$/) })
export type SecretRef = z.infer<typeof secretRefSchema>

export const targetSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(64),
    /** The catalog slug this target is shaped for. */
    widgetType: z.string().min(1).max(64),
    base: z
      .object({
        scheme: z.enum(['http', 'https']).default('http'),
        host: z.string().min(1).max(253),
        port: z.int().min(1).max(65535),
        // Prefix on every request to this target (for an iCalendar feed, the whole path). Checked
        // at write time so a traversal fails with a message rather than a widget that never loads.
        basePath: z
          .string()
          .max(120)
          .default('')
          .refine(
            // Percent-escapes are allowed because Google Calendar feeds contain `%40`; the URL
            // parser keeps them as written, so the origin-and-pathname check still holds.
            (value) => value === '' || /^\/(?:[A-Za-z0-9._~\-/]|%[0-9A-Fa-f]{2})*$/.test(value),
            'must be an absolute path containing only unreserved URL characters or %XX escapes',
          )
          .refine((value) => !value.split('/').includes('..'), 'must not contain ".."'),
      })
      // Strict, unlike the rest: an unknown key here has only ever meant a caller spread
      // something it should not have, once a plaintext API key.
      .strict(),
    /** Field name to secret reference. Values live in secrets/, never here. */
    secrets: z.record(z.string().max(32), secretRefSchema).default({}),
    fields: z
      .record(z.string().max(32), z.union([z.string(), z.number(), z.boolean()]))
      .prefault({}),
    tls: z.object({ insecureSkipVerify: z.boolean().default(false) }).prefault({}),
    minIntervalMs: z.int().min(1000).max(86_400_000).default(15_000),
  })
  .catchall(z.unknown())

export type Target = z.infer<typeof targetSchema>

export const widgetSchema = z
  .object({
    id: idSchema,
    page: idSchema,
    /** Catalog slug plus the exact revision this instance was installed from. */
    type: z.string().min(1).max(64),
    catalogRev: z.string().max(32).nullable().default(null),
    catalogSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    title: z.string().max(64).nullable().default(null),
    /** The grid section this widget sits in; null means the page's first grid section. */
    section: idSchema.nullable().default(null),
    // `inherit` follows the theme's `stat-*` tokens.
    look: z
      .object({
        stats: z.enum(['inherit', 'plain', 'boxed']).default('inherit'),
        align: z.enum(['inherit', 'start', 'center']).default('inherit'),
      })
      .prefault({}),
    targetId: idSchema.nullable().default(null),
    // Composite widgets only: role name -> bound targets, in order. Kept separate from `targetId`
    // so single-target widgets need no role map.
    bindings: z.record(z.string().max(32), z.array(idSchema).max(16)).prefault({}),
    operations: z.array(z.string().max(32)).default([]),
    config: z.record(z.string().max(32), z.unknown()).default({}),
    poll: z
      .object({ intervalMs: z.int().min(1000).max(86_400_000).nullable().default(null) })
      .prefault({}),
  })
  .catchall(z.unknown())

export type Widget = z.infer<typeof widgetSchema>

export const themeSchema = z
  .object({
    mode: z.enum(['light', 'dark', 'system']).default('system'),
    preset: z.string().max(64).default('default'),
    cssVars: z
      .object({
        theme: z.record(z.string().max(48), z.string().max(120)).default({}),
        light: z.record(z.string().max(48), z.string().max(120)).default({}),
        dark: z.record(z.string().max(48), z.string().max(120)).default({}),
      })
      .prefault({}),
    surface: z
      .object({
        background: z.string().max(200).nullable().default(null),
        blur: z.int().min(0).max(64).default(0),
        overlayOpacity: z.number().min(0).max(1).default(0),
      })
      .prefault({}),
  })
  .catchall(z.unknown())

export type Theme = z.infer<typeof themeSchema>

export const networkSchema = z
  .object({
    /** `offline` disables catalog and icon fetching ONLY. LAN polling is never affected. */
    mode: z.enum(['lan', 'offline']).default('lan'),
    /** Non-empty required when bound to a non-loopback address; enforced at boot, not here. */
    allowedHosts: z.array(z.string().max(253)).default([]),
    trustedProxies: z.array(z.string().max(64)).default([]),
  })
  .catchall(z.unknown())

export type Network = z.infer<typeof networkSchema>
