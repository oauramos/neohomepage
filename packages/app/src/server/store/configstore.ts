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
import { writeFileDurable, writeFilesDurable } from './atomic.ts'
import { collectionFile, configPaths, type CollectionName, type ConfigPaths } from './paths.ts'
import { schemaDefaults, schemaKeyOrder, serialize } from './serialize.ts'
import {
  toMutable,
  treeRevision,
  validateTree,
  type ConfigTree,
  type MutableConfigTree,
  type Problem,
} from './tree.ts'

/**
 * The single writer.
 *
 * Every mutation — the browser, an MCP agent, the importer, a migration — funnels through
 * `transaction()`: take the lock, re-read from disk, apply the change to a draft, validate the
 * whole prospective tree, then write only the files whose serialised bytes actually changed.
 *
 * Re-reading inside the lock rather than trusting a cached tree is what makes concurrent editing
 * safe without a database. A caller that cares about losing someone else's edit passes
 * `baseRevision` and gets a conflict instead of a silent overwrite.
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
  // Passing the schema itself (not just its top-level key order) is what makes nested objects
  // and array items come out in declaration order too — a layout item reads `i, x, y, w, h`
  // rather than alphabetically, which is the difference between a readable diff and a puzzle.
  return serialize(value, { schema, defaults: schemaDefaults(schema) })
}

type RawFile = { readonly text: string; readonly value: unknown }

/**
 * Read a file, keeping the raw bytes alongside the parsed value.
 *
 * The change detector compares the renderer's output against what is ACTUALLY on disk, not
 * against a re-render of the parsed value. Comparing render-to-render would make formatting
 * invisible: a file left alphabetical by an older release, or hand-edited with four-space indent,
 * would never be normalised, and a serialiser improvement would silently never reach existing
 * installs. Comparing to the bytes means the next transaction that touches the tree tidies it,
 * once, and then stays stable.
 */
async function readJson(path: string): Promise<RawFile | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return { text, value: JSON.parse(text) }
  } catch (error) {
    // A hand-edit or a bad git merge must produce a legible message naming the file, not a bare
    // SyntaxError from somewhere in the boot sequence.
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

  /**
   * In-process serialisation of transactions.
   *
   * The file lock only excludes other *processes* — the CLI running while the server is up. Two
   * concurrent requests inside this process (the browser saving a layout while an MCP agent adds
   * a widget, which is the normal case, not the exotic one) would interleave their awaits and
   * fight over the same lock. Chaining every transaction onto one promise makes the file lock a
   * cross-process guard and this the intra-process one.
   */
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
    for (const collection of ['pages', 'layouts', 'targets', 'widgets'] as const) {
      await mkdir(this.paths[collection], { recursive: true })
    }
  }

  /**
   * Load one directory of entities. The map key is always the file name, never a field inside the
   * file — a mismatch between the two is a validation problem to report, not something to paper
   * over by trusting whichever one happens to be read first.
   */
  private async loadCollection<T>(
    collection: CollectionName,
    schema: z.ZodType<T>,
    objectSchema: z.ZodObject,
    snapshot: Map<string, string>,
  ): Promise<Map<string, T>> {
    const out = new Map<string, T>()
    let names: string[]
    try {
      names = (await readdir(this.paths[collection])).filter((n) => n.endsWith('.json')).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out
      throw error
    }
    for (const name of names) {
      const path = join(this.paths[collection], name)
      const raw = await readJson(path)
      const parsed = parseOrThrow(schema, raw?.value, path)
      out.set(name.slice(0, -'.json'.length), parsed)
      if (raw !== undefined) snapshot.set(path, raw.text)
      void objectSchema
    }
    return out
  }

  async load(): Promise<LoadResult> {
    const snapshot = new Map<string, string>()
    const warnings: Problem[] = []

    // A file that does not exist gets NO snapshot entry, so the rendered output differs from
    // "what is on disk" and the file gets created. Recording a synthetic snapshot for an absent
    // file makes an all-defaults file — dashboard.json, which is just `schemaVersion` — invisible
    // to the change detector, and it would never land on disk at all.
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

    const pages = await this.loadCollection('pages', pageSchema, pageSchema, snapshot)
    const layouts = await this.loadCollection(
      'layouts',
      layoutFileSchema,
      layoutFileSchema,
      snapshot,
    )
    const targets = await this.loadCollection('targets', targetSchema, targetSchema, snapshot)
    const widgets = await this.loadCollection('widgets', widgetSchema, widgetSchema, snapshot)

    for (const [name, value] of [
      ['dashboard.json', dashboard],
      ['theme.json', theme],
      ['network.json', network],
    ] as const) {
      const known = new Set(
        schemaKeyOrder(SINGLETON_SCHEMAS[name.replace('.json', '') as 'dashboard']),
      )
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          warnings.push({
            path: name,
            message: `unknown key "${key}" — kept as-is; it may come from a newer release`,
          })
        }
      }
    }

    const tree: ConfigTree = { dashboard, theme, network, pages, layouts, targets, widgets }
    return { tree, revision: treeRevision(tree), warnings, snapshot }
  }

  /** Serialise a whole tree to the exact file contents it would occupy on disk. */
  renderTree(tree: ConfigTree): Map<string, string> {
    const files = new Map<string, string>()
    files.set(this.paths.dashboard, render(dashboardSchema, tree.dashboard))
    files.set(this.paths.theme, render(themeSchema, tree.theme))
    files.set(this.paths.network, render(networkSchema, tree.network))
    for (const collection of ['pages', 'layouts', 'targets', 'widgets'] as const) {
      const schema = COLLECTION_SCHEMAS[collection]
      for (const [id, entity] of tree[collection]) {
        files.set(collectionFile(this.paths, collection, id), render(schema, entity))
      }
    }
    return files
  }

  /**
   * Apply a change under the lock.
   *
   * `mutate` receives a deep copy, so a throw part-way leaves nothing half-applied in memory, and
   * validation runs on the finished draft before a single byte reaches disk.
   */
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
    // The mkdir strategy is the only lock that behaves on NFS and SMB, which is exactly where a
    // git-synced config directory tends to live.
    const release = await lockfile.lock(this.paths.root, {
      stale: 10_000,
      // Generous, because the competing holder is another process (the CLI, a migration) doing
      // real work, and failing a user's save to avoid a two-second wait is the wrong trade.
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

  /** Write one file outside the tree model, used by the seeder. */
  async writeRaw(path: string, contents: string): Promise<void> {
    await writeFileDurable(path, contents)
  }
}
