import { z } from 'zod'

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
        url: z.url().default('https://catalog.neohomepage.dev/v1/latest.json'),
        pinnedRelease: z.string().max(64).nullable().default(null),
        autoUpdate: z.boolean().default(true),
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

export const pageSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(64).default('Home'),
    icon: z.string().max(64).nullable().default(null),
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
        basePath: z.string().max(120).default(''),
      })
      .catchall(z.unknown()),
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
    targetId: idSchema.nullable().default(null),
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
