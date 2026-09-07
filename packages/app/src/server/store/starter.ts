import { dashboardSchema, pageSchema, CURRENT_SCHEMA_VERSION } from '../config/schema.ts'
import { ConfigStore } from './configstore.ts'

/**
 * The smallest config that validates: one dashboard, one empty page.
 *
 * A freshly-seeded directory with no config at all is *invalid*, not merely empty — dashboard.json
 * lists a default page that has no file. Rather than teaching the validator to tolerate a state
 * nothing else can use, the first boot writes a real starting point.
 *
 * It goes through a normal transaction, so the starter tree is validated by the same code as every
 * later edit: there is no privileged path that can write something the app would then reject.
 */
export async function seedStarterConfig(configDir: string): Promise<string[]> {
  const store = new ConfigStore(configDir)
  // Gate on the tree rather than on one file: config is sparse, so "no dashboard.json" and
  // "an all-default dashboard.json" mean the same thing, and only the page list distinguishes a
  // first boot from a deliberately empty dashboard.
  const existing = await store.load()
  if (existing.tree.pages.size > 0) return []

  const result = await store.transaction('seed', (draft) => {
    draft.dashboard = dashboardSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION })
    draft.pages.set('home', pageSchema.parse({ id: 'home' }))
  })
  return result.changed
}
