import { join } from 'node:path'

/**
 * Where every file lives. One module so the store, the seeder, the backup command and
 * `neo doctor` cannot disagree about the shape of the tree.
 */
export type ConfigPaths = {
  readonly root: string
  readonly dashboard: string
  readonly theme: string
  readonly network: string
  readonly overrides: string
  readonly audit: string
  readonly pages: string
  readonly layouts: string
  readonly targets: string
  readonly widgets: string
}

export function configPaths(configDir: string): ConfigPaths {
  return {
    root: configDir,
    dashboard: join(configDir, 'dashboard.json'),
    theme: join(configDir, 'theme.json'),
    network: join(configDir, 'network.json'),
    /** Per-machine and gitignored: the reason laptop-vs-NAS URLs do not stop people git-syncing. */
    overrides: join(configDir, 'overrides.local.json'),
    audit: join(configDir, '.audit.jsonl'),
    pages: join(configDir, 'pages'),
    layouts: join(configDir, 'layouts'),
    targets: join(configDir, 'targets'),
    widgets: join(configDir, 'widgets'),
  }
}

/** Directories holding one file per entity, keyed by the entity id. */
export const COLLECTION_DIRECTORIES = ['pages', 'layouts', 'targets', 'widgets'] as const
export type CollectionName = (typeof COLLECTION_DIRECTORIES)[number]

export function collectionFile(paths: ConfigPaths, collection: CollectionName, id: string): string {
  return join(paths[collection], `${id}.json`)
}
