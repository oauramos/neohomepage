import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigTooNewError,
  MigrationFailedError,
  migrateConfig,
  readSchemaVersion,
  type Migration,
} from './migrations.ts'

const created: string[] = []
let dataDir = ''
let configDir = ''
let stateDir = ''

const NOW = () => '2026-09-07T00-00-00-000Z'

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'neo-migrate-'))
  created.push(dataDir)
  configDir = join(dataDir, 'config')
  stateDir = join(dataDir, 'state')
  await mkdir(join(configDir, 'targets'), { recursive: true })
  await mkdir(join(configDir, 'widgets'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
})

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

async function writeTree(version: number): Promise<void> {
  await writeFile(
    join(configDir, 'dashboard.json'),
    `${JSON.stringify({ schemaVersion: version, title: 'home' }, null, 2)}\n`,
  )
  await writeFile(
    join(configDir, 'widgets', 'w1.json'),
    `${JSON.stringify({ id: 'w1', page: 'home', type: 'sonarr-queue' }, null, 2)}\n`,
  )
  await writeFile(join(configDir, 'overrides.local.json'), '{"widgets":{"w1":{"config":{}}}}\n')
}

const read = async (relative: string) =>
  JSON.parse(await readFile(join(configDir, relative), 'utf8')) as Record<string, unknown>

/** A migration that renames a key, so the test can see it actually ran. */
const renameTitle: Migration = {
  to: 1,
  summary: 'rename title to heading',
  apply: (tree) => {
    const files = new Map(tree.files)
    const dashboard = files.get('dashboard.json')
    if (dashboard !== undefined) {
      const { title, ...rest } = dashboard
      files.set('dashboard.json', { ...rest, heading: title })
    }
    return { files }
  },
}

describe('doing nothing', () => {
  it('is a no-op when config is already current', async () => {
    await writeTree(1)
    const result = await migrateConfig({ configDir, stateDir, now: NOW })
    expect(result).toMatchObject({ migrated: false, from: 1, backupPath: null })
    expect(await readdir(stateDir)).toEqual([])
  })

  it('treats a missing dashboard.json as a fresh install at the current version', async () => {
    expect(await readSchemaVersion(configDir)).toBe(1)
  })
})

describe('refusing config from the future', () => {
  it('throws before opening anything', async () => {
    await writeTree(9)
    await expect(migrateConfig({ configDir, stateDir, now: NOW })).rejects.toThrow(
      ConfigTooNewError,
    )
    expect(await readdir(stateDir)).toEqual([])
  })

  it('says what to do about it', async () => {
    await writeTree(9)
    await expect(migrateConfig({ configDir, stateDir, now: NOW })).rejects.toThrow(
      /upgrade neohomepage/,
    )
  })
})

describe('migrating forward', () => {
  it('applies the migration, stamps the version and backs the tree up first', async () => {
    await writeTree(0)
    const result = await migrateConfig({
      configDir,
      stateDir,
      now: NOW,
      migrations: [renameTitle],
    })

    expect(result.migrated).toBe(true)
    expect(result.applied).toEqual(['v1: rename title to heading'])
    expect(await read('dashboard.json')).toEqual({ schemaVersion: 1, heading: 'home' })

    const backup = join(stateDir, 'backups', 'pre-migrate-v0-2026-09-07T00-00-00-000Z')
    const restored = JSON.parse(
      await readFile(join(backup, 'config', 'dashboard.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(restored).toEqual({ schemaVersion: 0, title: 'home' })
    expect(await readFile(join(backup, 'config', 'widgets', 'w1.json'), 'utf8')).toContain('w1')
    expect(await readFile(join(backup, 'README.md'), 'utf8')).toContain('rename title to heading')
  })

  it('leaves the per-machine overrides file alone', async () => {
    await writeTree(0)
    const before = await readFile(join(configDir, 'overrides.local.json'), 'utf8')
    await migrateConfig({ configDir, stateDir, now: NOW, migrations: [renameTitle] })
    expect(await readFile(join(configDir, 'overrides.local.json'), 'utf8')).toBe(before)
  })

  it('skips a migration whose target version is not ahead of the current one', async () => {
    const trail: number[] = []
    const step = (to: number): Migration => ({
      to,
      summary: `step ${to}`,
      apply: (tree) => {
        trail.push(to)
        return tree
      },
    })
    await writeTree(0)
    const result = await migrateConfig({
      configDir,
      stateDir,
      now: NOW,
      // to: -1 is below `from`, so it must be filtered out, not run.
      migrations: [step(1), step(-1)],
    })
    expect(trail).toEqual([1])
    expect(result.to).toBe(1)
  })
})

describe('when a migration fails', () => {
  it('writes nothing and points at the backup', async () => {
    await writeTree(0)
    const explode: Migration = {
      to: 1,
      summary: 'explode',
      apply: () => {
        throw new Error('bad data')
      },
    }

    await expect(
      migrateConfig({ configDir, stateDir, now: NOW, migrations: [explode] }),
    ).rejects.toThrow(MigrationFailedError)

    expect(await read('dashboard.json')).toEqual({ schemaVersion: 0, title: 'home' })
  })

  it('refuses when no migration path exists rather than half-upgrading', async () => {
    await writeTree(0)
    await expect(migrateConfig({ configDir, stateDir, now: NOW, migrations: [] })).rejects.toThrow(
      /no migration path exists/,
    )
    expect(await read('dashboard.json')).toEqual({ schemaVersion: 0, title: 'home' })
  })
})
