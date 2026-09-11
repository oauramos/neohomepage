import { z } from 'zod'
import { parseIconRef } from '../assets/icons.ts'

/**
 * The on-disk config tree.
 *
 * Sparse by design: a file stores only what differs from the schema default, so a one-field change
 * is a one-line diff in the user's git repository. The dense, fully-evaluated form lives in
 * state/resolved.json and is never written by hand.
 *
 * Every file schema uses `.catchall(z.unknown())`. That is deliberate: someone who tries a newer
 * release and rolls back must not silently lose the fields the newer version added. Unknown keys
 * survive a read/write round trip; `neo doctor` reports them rather than the loader deleting them.
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
        /**
         * Where the catalog is actually served from today.
         *
         * One GitHub Pages site per repository, so the catalog ships inside the docs site rather
         * than on a subdomain. A `*.github.io/<repo>/` URL is normally a thing to avoid baking in
         * precisely because it cannot move — but the pointer file carries `movedTo`, so when this
         * gets a custom domain or its own repository the old URL keeps answering and says where
         * the payload went. That is what the two-file pointer design is for.
         */
        url: z.url().default('https://oauramos.github.io/neohomepage/catalog/v1/latest.json'),
        pinnedRelease: z.string().max(64).nullable().default(null),
        autoUpdate: z.boolean().default(true),
      })
      .prefault({}),
    /**
     * Optional behaviour, off by default.
     *
     * A dashboard is a thing people leave open on a wall, and the two floating buttons are the only
     * chrome on it. `autoHideControls` fades them once you stop interacting and brings them back
     * when the pointer nears their corner — useful on a wall display, wrong on a laptop, so it is a
     * choice rather than a default. Keyboard focus always overrides it: a control that cannot be
     * tabbed to is not hidden, it is gone.
     */
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
 * Where a bookmark or a navbar link points, as parts rather than a URL string.
 *
 * The same keys as a target's `base`, for the same reason: nothing in config, in the API or in an
 * MCP tool call is ever a URL. The server composes one at render time, and the path is held to
 * the two rules the `targetUrl` opcode applies to a deep link.
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

/**
 * An icon is named, never linked: `nextcloud` (dashboard-icons), `si-nextcloud` (Simple Icons),
 * `mdi-router-network` (Material Design Icons), with an optional `-#rrggbb`. The server fetches
 * it; a name is not a URL.
 */
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

/** The four ways a bookmark group can be drawn. A closed set: each one is CSS this build ships. */
export const BOOKMARK_DISPLAYS = ['list', 'cards', 'icons', 'chips'] as const
export type BookmarkDisplay = (typeof BOOKMARK_DISPLAYS)[number]

/** Where a search box sends its query. Closed, because an engine is a URL and a URL is not config. */
export const SEARCH_ENGINES = [
  'duckduckgo',
  'google',
  'bing',
  'brave',
  'startpage',
  'kagi',
] as const
export type SearchEngine = (typeof SEARCH_ENGINES)[number]

/**
 * What a navbar is made of, in order. Each item is one thing the user asked for in the header:
 * the dashboard title, a line of text, a row of links, a clock, a search box, or a spacer that
 * pushes what follows to the far edge.
 */
export const navItemSchema = z.discriminatedUnion('kind', [
  z.object({ id: idSchema, kind: z.literal('title') }).catchall(z.unknown()),
  z
    .object({ id: idSchema, kind: z.literal('text'), text: z.string().min(1).max(120) })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('links'),
      links: z.array(bookmarkLinkSchema).max(24).default([]),
    })
    .catchall(z.unknown()),
  z
    .object({
      id: idSchema,
      kind: z.literal('clock'),
      showDate: z.boolean().default(true),
      hour12: z.boolean().default(false),
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
 * A page is a stack of sections, each one of three kinds.
 *
 * A `navbar` is the header; a `grid` is a free board of widgets with its own column count and row
 * cap; `bookmarks` is named groups of links laid out in columns and drawn in one of four styles.
 * Every per-breakpoint number here is a record keyed by breakpoint id and SPARSE: an absent key
 * falls back to the page's grid for a grid section, and to a built-in default for bookmarks.
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
    /**
     * Empty means the page every install had before sections existed: a header carrying the title
     * over one grid. The resolver synthesises exactly that, so no file on disk needs a migration
     * and a page that never opened the sections panel never grows the key.
     */
    sections: z.array(sectionSchema).max(24).default([]),
    grid: z
      .object({
        rowHeight: z.int().min(16).max(400).default(56),
        margin: z.tuple([z.int().min(0).max(64), z.int().min(0).max(64)]).default([12, 12]),
        containerPadding: z
          .tuple([z.int().min(0).max(64), z.int().min(0).max(64)])
          .default([16, 16]),
        /**
         * A real cap, not a decorative field: with it set, the auto-placer refuses when the grid
         * is full and says so, instead of pushing a widget below the fold on a wall display.
         */
        maxRows: z.int().min(1).max(200).nullable().default(null),
        /** Three authored tiers. Every extra one is another place the board can silently desync. */
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
    /**
     * `origin` is what stops react-grid-layout dirtying a git-tracked file on every window
     * resize: it emits machine-generated layouts for breakpoints nobody authored, and those are
     * regenerated from the authoritative tier rather than persisted.
     */
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
        /**
         * A prefix on every request to this target, and for an iCalendar feed the whole path.
         *
         * Shape-checked here rather than only at request time: the executor's origin-and-pathname
         * assertion already refuses a traversal (the URL parser normalises `/a/../b` and the
         * comparison then fails), but failing at write time with a message beats a widget that
         * silently never loads.
         */
        basePath: z
          .string()
          .max(120)
          .default('')
          .refine(
            (value) => value === '' || /^\/[A-Za-z0-9._~\-/]*$/.test(value),
            'must be an absolute path containing only unreserved URL characters',
          )
          .refine((value) => !value.split('/').includes('..'), 'must not contain ".."'),
      })
      // Strict, unlike every other object here. The document-level catchall exists so a rollback
      // does not silently drop fields a newer release added; `base` is a closed shape of four
      // keys, and an unknown key in it has only ever meant a caller spread something it should
      // not have. Once that something was a plaintext API key.
      .strict(),
    /** Field name to secret reference. Values live in secrets/, never here. */
    secrets: z.record(z.string().max(32), secretRefSchema).default({}),
    /** Non-secret target fields the manifest declares. */
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
    /**
     * How this tile draws its readings, where it differs from the dashboard's default: boxed or
     * bare, centred or not. `inherit` — the default — follows the theme's `stat-*` tokens, so a
     * file only grows this key when someone chose for one tile.
     */
    look: z
      .object({
        stats: z.enum(['inherit', 'plain', 'boxed']).default('inherit'),
        align: z.enum(['inherit', 'start', 'center']).default('inherit'),
      })
      .prefault({}),
    targetId: idSchema.nullable().default(null),
    /**
     * Composite widgets only: role name -> the targets bound to it, in the order the user chose.
     *
     * Separate from `targetId` rather than a generalisation of it. Almost every widget binds one
     * target, and forcing those through a role map would make the common config file harder to
     * read and every existing file a migration, to express something only the calendar needs.
     */
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

/** Every file kind, so the store, the seeder and `neo doctor` all agree on what exists. */
export const FILE_SCHEMAS = {
  dashboard: dashboardSchema,
  page: pageSchema,
  layout: layoutFileSchema,
  target: targetSchema,
  widget: widgetSchema,
  theme: themeSchema,
  network: networkSchema,
} as const

export type FileKind = keyof typeof FILE_SCHEMAS
