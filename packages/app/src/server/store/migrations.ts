import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '../config/schema.ts'
import { writeFileDurable } from './atomic.ts'

/**
 * Config migrations.
 *
 * A migration is a PURE function from one JSON document to the next. It never touches disk, never
 * reads the clock and never fails on data it does not recognise, because it runs against files a
 * stranger wrote two years ago and restored this morning. Everything IO-shaped — the backup, the
 * ordering, the refusal — lives in the runner below, where it can be tested once.
 *
 * Three rules the runner enforces, each earned from a way this goes wrong:
 *
 *   1. Config NEWER than the build is refused outright, never opened. Parsing it would drop the
 *      fields this version does not know and the next save would write the loss to disk — a
 *      downgrade that silently deletes work.
 *   2. The whole tree is copied to `state/backups/` BEFORE anything is written. Not the changed
 *      files: the tree, because a migration that only half-applies is the case you need it for.
 *   3. All-or-nothing. Migrations are applied in memory and written in one pass at the end, so a
 *      crash between two of them leaves the tree exactly as it was.
 */

export type Document = Record<string, unknown>

export type MigratedTree = {
  /** Relative path within config/ to the parsed document. */
  readonly files: ReadonlyMap<string, Document>
}

export type Migration = {
  /** The version this migration produces. Applied when config is at `to - 1`. */
  readonly to: number
  readonly summary: string
  /** Pure. Same input, same output, no IO, no clock. */
  readonly apply: (tree: MigratedTree) => MigratedTree
}

/**
 * The migrations, in order.
 *
 * Empty at schemaVersion 1: there is no earlier version to come from. The runner, its backup and
 * its refusal are built and tested now anyway — the first person to need a migration will be
 * someone restoring a two-year-old backup, and that is a terrible moment to be writing this.
 */
export const MIGRATIONS: readonly Migration[] = []

export class ConfigTooNewError extends Error {
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(
      `this config is schemaVersion ${found}, and this build understands up to ${supported} — ` +
        'upgrade neohomepage, or restore a backup taken with this version',
    )
    this.name = 'ConfigTooNewError'
    this.found = found
    this.supported = supported
  }
}

export class MigrationFailedError extends Error {
  readonly backupPath: string

  constructor(message: string, backupPath: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MigrationFailedError'
    this.backupPath = backupPath
  }
}

/** Read the version without parsing the tree, so a future version is refused before it is opened. */
export async function readSchemaVersion(configDir: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(configDir, 'dashboard.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && 'schemaVersion' in parsed) {
      const version = (parsed as { schemaVersion: unknown }).schemaVersion
      if (typeof version === 'number' && Number.isInteger(version)) return version
    }
  } catch {
    // Absent or unreadable: a fresh install, which is at the current version by definition.
  }
  return CURRENT_SCHEMA_VERSION
}

async function readTree(configDir: string): Promise<Map<string, Document>> {
  const files = new Map<string, Document>()

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      // overrides.local.json is per-machine and gitignored; migrating it would rewrite a file the
      // user maintains by hand on this box alone.
      if (relative === 'overrides.local.json') continue
      const parsed: unknown = JSON.parse(await readFile(join(dir, entry.name), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        files.set(relative, parsed as Document)
      }
    }
  }

  await walk(configDir, '')
  return files
}

export type MigrateResult = {
  readonly migrated: boolean
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
  readonly backupPath: string | null
}

export async function migrateConfig(options: {
  readonly configDir: string
  readonly stateDir: string
  /** Injected so the backup directory name is deterministic in a test. */
  readonly now: () => string
  readonly migrations?: readonly Migration[]
}): Promise<MigrateResult> {
  const migrations = options.migrations ?? MIGRATIONS
  const from = await readSchemaVersion(options.configDir)

  if (from > CURRENT_SCHEMA_VERSION) throw new ConfigTooNewError(from, CURRENT_SCHEMA_VERSION)
  if (from === CURRENT_SCHEMA_VERSION) {
    return { migrated: false, from, to: from, applied: [], backupPath: null }
  }

  const pending = migrations
    .filter((migration) => migration.to > from && migration.to <= CURRENT_SCHEMA_VERSION)
    .sort((a, b) => a.to - b.to)

  if (pending.length === 0) {
    throw new Error(
      `config is schemaVersion ${from} and this build is ${CURRENT_SCHEMA_VERSION}, but no ` +
        'migration path exists — this is a bug in the release, not in your config',
    )
  }

  // Before a byte is written. Not the files a migration touches: the whole tree, because a
  // half-applied migration is exactly the situation this is kept for.
  const backupPath = join(options.stateDir, 'backups', `pre-migrate-v${from}-${options.now()}`)
  await mkdir(backupPath, { recursive: true })
  await cp(options.configDir, join(backupPath, 'config'), { recursive: true })

  let tree: MigratedTree = { files: await readTree(options.configDir) }
  const applied: string[] = []

  for (const migration of pending) {
    try {
      tree = migration.apply(tree)
      applied.push(`v${migration.to}: ${migration.summary}`)
    } catch (error) {
      throw new MigrationFailedError(
        `migration to v${migration.to} (${migration.summary}) failed; nothing was written`,
        backupPath,
        { cause: error },
      )
    }
  }

  // Written only once every migration has succeeded, so a crash in the middle leaves the tree
  // exactly as it was and the backup is a belt to the braces rather than the only rescue.
  const output = new Map(tree.files)
  output.set('dashboard.json', {
    ...(output.get('dashboard.json') ?? {}),
    schemaVersion: CURRENT_SCHEMA_VERSION,
  })

  for (const [relative, document] of output) {
    const path = join(options.configDir, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFileDurable(path, `${JSON.stringify(document, null, 2)}\n`)
  }

  await writeFile(
    join(backupPath, 'README.md'),
    `# Pre-migration backup\n\nTaken before migrating config from schemaVersion ${from} to ` +
      `${CURRENT_SCHEMA_VERSION}.\n\nApplied:\n\n${applied.map((one) => `- ${one}`).join('\n')}\n\n` +
      'To go back: stop neohomepage, replace config/ with the copy in this directory, and\n' +
      'downgrade to the version that wrote it.\n',
  )

  return { migrated: true, from, to: CURRENT_SCHEMA_VERSION, applied, backupPath }
}
