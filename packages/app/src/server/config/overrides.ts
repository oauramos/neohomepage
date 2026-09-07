import { z } from 'zod'
import { idSchema } from './schema.ts'

/**
 * `config/overrides.local.json` — gitignored, per-machine.
 *
 * This one file is why people keep git-syncing their dashboard. The same repository gets checked
 * out on a laptop and on the NAS, where the same Sonarr is reachable at different addresses; with
 * nowhere to put that difference, the alternative is committing a machine-specific URL and then
 * fighting the diff forever.
 *
 * It is deliberately narrow: addresses and instance config, nothing structural. A local override
 * that could add or remove a widget would make two machines show different dashboards from the
 * same repository, which is the property being protected.
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
