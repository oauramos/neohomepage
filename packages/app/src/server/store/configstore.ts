import { mkdir, readFile, readdir, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import type { z } from 'zod'
import {
  CURRENT_SCHEMA_VERSION,
  dashboardSchema,
  layoutFileSchema,
  networkSchema,
  pageSchema,
  targetSchema,
  themeSchema,
  widgetSchema,
} from '../config/schema.ts'
import { writeFilesDurable } from './atomic.ts'
import { isEnoent } from './fs.ts'
import {
  COLLECTION_DIRECTORIES,
  collectionFile,
  configPaths,
  type CollectionName,
  type ConfigPaths,
} from './paths.ts'
import { schemaKeyOrder, serialize } from './serialize.ts'
import {
  toMutable,
  treeRevision,
  validateTree,
  type ConfigTree,
  type MutableConfigTree,
  type Problem,
} from './tree.ts'

/**
 * The single writer. Every mutation goes through `transaction()`: lock, re-read from disk, apply
 * to a draft, validate the whole tree, write only the files whose serialised bytes changed.
 */

export class ConfigConflictError extends Error {
  readonly expected: string
  readonly actual: string

  constructor(expected: string, actual: string) {
    super(`config changed underneath this edit (expected revision ${expected}, found ${actual})`)
    this.name = 'ConfigConflictError'
    this.expected = expected
    this.actual = actual
  }
}

export class ConfigInvalidError extends Error {
  readonly problems: readonly Problem[]

  constructor(problems: readonly Problem[]) {
    super(
      `config would be invalid:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`,
    )
    this.name = 'ConfigInvalidError'
    this.problems = problems
  }
}

export type LoadResult = {
  readonly tree: ConfigTree
  readonly revision: string
  /** Non-fatal: a file from a newer release, or a key this build does not know. Never dropped. */
  readonly warnings: readonly Problem[]
  /** Raw serialised bytes as loaded, so a transaction can write only what really changed. */
  readonly snapshot: ReadonlyMap<string, string>
}

const COLLECTION_SCHEMAS = {
  pages: pageSchema,
  layouts: layoutFileSchema,
  targets: targetSchema,
  widgets: widgetSchema,
} as const satisfies Record<CollectionName, z.ZodObject>

const SINGLETON_SCHEMAS = {
  dashboard: dashboardSchema,
  theme: themeSchema,
  network: networkSchema,
} as const

function render(schema: z.ZodObject, value: unknown): string {
  // The full schema, not just its top-level key order, so nested objects and array items also
  // serialise in declaration order.
  return serialize(value, { schema })
}

type RawFile = { readonly text: string; readonly value: unknown }

/**
 * Read a file keeping the raw bytes: change detection compares rendered output to what is on
 * disk, so stale formatting is normalised by the next transaction.
 */
async function readJson(path: string): Promise<RawFile | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
  try {
    return { text, value: JSON.parse(text) }
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
    )
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  throw new Error(`${path} does not match the schema: ${issues}`)
}

export class ConfigStore {
  readonly paths: ConfigPaths

  // The file lock only excludes other processes; this chain serialises transactions within this one.
  #queue: Promise<unknown> = Promise.resolve()

  constructor(configDir: string) {
    this.paths = configPaths(configDir)
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work)
    // Swallow rejection on the chain itself so one failed transaction does not poison the queue.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.paths.root, { recursive: true })
    for (const collection of COLLECTION_DIRECTORIES) {
      await mkdir(this.paths[collection], { recursive: true })
    }
  }

  /** The map key is the file name, never a field inside the file; a mismatch is a validation problem. */
  private async loadCollection<T>(
    collection: CollectionName,
    schema: z.ZodType<T>,
    snapshot: Map<string, string>,
  ): Promise<Map<string, T>> {
    const out = new Map<string, T>()
    let names: string[]
    try {
      names = (await readdir(this.paths[collection])).filter((n) => n.endsWith('.json')).sort()
    } catch (error) {
      if (isEnoent(error)) return out
      throw error
    }
    for (const name of names) {
      const path = join(this.paths[collection], name)
      const raw = await readJson(path)
      const parsed = parseOrThrow(schema, raw?.value, path)
      out.set(name.slice(0, -'.json'.length), parsed)
      if (raw !== undefined) snapshot.set(path, raw.text)
    }
    return out
  }

  async load(): Promise<LoadResult> {
    const snapshot = new Map<string, string>()
    const warnings: Problem[] = []

    // An absent file gets no snapshot entry; otherwise an all-defaults file such as dashboard.json
    // would never be created.
    const dashboardRaw = await readJson(this.paths.dashboard)
    const dashboard = parseOrThrow(
      dashboardSchema,
      dashboardRaw?.value ?? { schemaVersion: CURRENT_SCHEMA_VERSION },
      this.paths.dashboard,
    )
    if (dashboardRaw !== undefined) snapshot.set(this.paths.dashboard, dashboardRaw.text)

    const themeRaw = await readJson(this.paths.theme)
    const theme = parseOrThrow(themeSchema, themeRaw?.value ?? {}, this.paths.theme)
    if (themeRaw !== undefined) snapshot.set(this.paths.theme, themeRaw.text)

    const networkRaw = await readJson(this.paths.network)
    const network = parseOrThrow(networkSchema, networkRaw?.value ?? {}, this.paths.network)
    if (networkRaw !== undefined) snapshot.set(this.paths.network, networkRaw.text)

    const pages = await this.loadCollection('pages', pageSchema, snapshot)
    const layouts = await this.loadCollection('layouts', layoutFileSchema, snapshot)
    const targets = await this.loadCollection('targets', targetSchema, snapshot)
    const widgets = await this.loadCollection('widgets', widgetSchema, snapshot)

    const tree: ConfigTree = { dashboard, theme, network, pages, layouts, targets, widgets }
    for (const name of ['dashboard', 'theme', 'network'] as const) {
      const known = new Set(schemaKeyOrder(SINGLETON_SCHEMAS[name]))
      for (const key of Object.keys(tree[name])) {
        if (!known.has(key)) {
          warnings.push({
            path: `${name}.json`,
            message: `unknown key "${key}" — kept as-is; it may come from a newer release`,
          })
        }
      }
    }
    return { tree, revision: treeRevision(tree), warnings, snapshot }
  }

  /** Serialise a whole tree to the exact file contents it would occupy on disk. */
  renderTree(tree: ConfigTree): Map<string, string> {
    const files = new Map<string, string>()
    files.set(this.paths.dashboard, render(dashboardSchema, tree.dashboard))
    files.set(this.paths.theme, render(themeSchema, tree.theme))
    files.set(this.paths.network, render(networkSchema, tree.network))
    for (const collection of COLLECTION_DIRECTORIES) {
      const schema = COLLECTION_SCHEMAS[collection]
      for (const [id, entity] of tree[collection]) {
        files.set(collectionFile(this.paths, collection, id), render(schema, entity))
      }
    }
    return files
  }

  /** Apply a change under the lock. `mutate` gets a deep copy; the draft is validated before anything is written. */
  async transaction(
    actor: string,
    mutate: (draft: MutableConfigTree) => unknown,
    options: { readonly baseRevision?: string } = {},
  ): Promise<{ revision: string; changed: string[]; removed: string[] }> {
    return this.#serialize(() => this.#applyTransaction(actor, mutate, options))
  }

  async #applyTransaction(
    actor: string,
    mutate: (draft: MutableConfigTree) => unknown,
    options: { readonly baseRevision?: string },
  ): Promise<{ revision: string; changed: string[]; removed: string[] }> {
    await this.ensureDirectories()
    // mkdir-based locking is the only kind that behaves on NFS and SMB.
    const release = await lockfile.lock(this.paths.root, {
      stale: 10_000,
      // Generous: the competing holder is another process doing real work.
      retries: { retries: 10, minTimeout: 50, maxTimeout: 1_000 },
      realpath: false,
    })
    try {
      const current = await this.load()
      if (options.baseRevision !== undefined && options.baseRevision !== current.revision) {
        throw new ConfigConflictError(options.baseRevision, current.revision)
      }

      const draft = toMutable(current.tree)
      await mutate(draft)

      const next: ConfigTree = draft
      const problems = validateTree(next)
      if (problems.length > 0) throw new ConfigInvalidError(problems)

      const rendered = this.renderTree(next)
      const changed: string[] = []
      for (const [path, contents] of rendered) {
        if (current.snapshot.get(path) !== contents) changed.push(path)
      }
      const removed = [...current.snapshot.keys()].filter((path) => !rendered.has(path))

      if (changed.length > 0) {
        await writeFilesDurable(
          new Map(changed.map((path) => [path, rendered.get(path) as string])),
        )
      }
      for (const path of removed) await rm(path, { force: true })

      const revision = treeRevision(next)
      if (changed.length > 0 || removed.length > 0) {
        await appendFile(
          this.paths.audit,
          `${JSON.stringify({ ts: new Date().toISOString(), actor, revision, changed, removed })}\n`,
        )
      }
      return { revision, changed, removed }
    } finally {
      await release()
    }
  }
}
