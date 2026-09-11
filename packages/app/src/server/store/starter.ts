import { dashboardSchema, pageSchema, CURRENT_SCHEMA_VERSION } from '../config/schema.ts'
import { ConfigStore } from './configstore.ts'

/**
 * Writes the smallest config that validates: one dashboard, one empty page. A directory with no
 * config is invalid (dashboard.json lists a default page with no file), and going through a normal
 * transaction means the starter tree passes the same validation as every later edit.
 */
export async function seedStarterConfig(configDir: string): Promise<string[]> {
  const store = new ConfigStore(configDir)
  // Config is sparse, so a missing dashboard.json and an all-default one look the same; only the
  // page list distinguishes a first boot from a deliberately empty dashboard.
  const existing = await store.load()
  if (existing.tree.pages.size > 0) return []

  const result = await store.transaction('seed', (draft) => {
    draft.dashboard = dashboardSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION })
    draft.pages.set('home', pageSchema.parse({ id: 'home' }))
  })
  return result.changed
}
