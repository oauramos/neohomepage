import { z } from 'zod'
import { idSchema } from './schema.ts'

/**
 * Schema for `config/overrides.local.json` (gitignored, per-machine). Deliberately narrow: target
 * addresses and widget config only, so two checkouts of the same repository show the same widgets.
 */
export const overridesSchema = z
  .object({
    targets: z
      .record(
        idSchema,
        z
          .object({
            base: z
              .object({
                scheme: z.enum(['http', 'https']).optional(),
                host: z.string().min(1).max(253).optional(),
                port: z.int().min(1).max(65535).optional(),
                basePath: z.string().max(120).optional(),
              })
              .optional(),
          })
          .catchall(z.unknown()),
      )
      .default({}),
    widgets: z
      .record(
        idSchema,
        z
          .object({ config: z.record(z.string().max(32), z.unknown()).optional() })
          .catchall(z.unknown()),
      )
      .default({}),
  })
  .catchall(z.unknown())

export type Overrides = z.infer<typeof overridesSchema>

export const EMPTY_OVERRIDES: Overrides = { targets: {}, widgets: {} }
