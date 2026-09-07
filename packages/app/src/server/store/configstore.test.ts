import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pageSchema, targetSchema, widgetSchema } from '../config/schema.ts'
import { ConfigConflictError, ConfigInvalidError, ConfigStore } from './configstore.ts'

const created: string[] = []

async function store(): Promise<ConfigStore> {
  const dir = await mkdtemp(join(tmpdir(), 'neo-config-'))
  created.push(dir)
  const s = new ConfigStore(dir)
  await s.ensureDirectories()
  await s.transaction('test', (draft) => {
    draft.pages.set('home', pageSchema.parse({ id: 'home' }))
  })
  return s
}

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

const widget = (id: string, extra: Record<string, unknown> = {}) =>
  widgetSchema.parse({ id, page: 'home', type: 'sonarr-queue', ...extra })

describe('round trip', () => {
  it('writes sparse files: only what differs from the schema default', async () => {
    const s = await store()
    await s.transaction('test', (draft) => draft.widgets.set('w1', widget('w1')))
    const written = JSON.parse(await readFile(join(s.paths.widgets, 'w1.json'), 'utf8'))
    // No catalogRev: null, no poll: {}, no empty config — those are all defaults.
    expect(written).toEqual({ id: 'w1', page: 'home', type: 'sonarr-queue' })
  })

  it('reads a sparse file back as a dense object', async () => {
    const s = await store()
    await writeFile(join(s.paths.widgets, 'w2.json'), '{"id":"w2","page":"home","type":"clock"}\n')
    const { tree } = await s.load()
    expect(tree.widgets.get('w2')).toMatchObject({
      id: 'w2',
      catalogRev: null,
      config: {},
      operations: [],
    })
  })

  it('emits keys in schema order, so a git diff is about content and not ordering', async () => {
    const s = await store()
    await s.transaction('test', (draft) =>
      draft.targets.set(
        'tSonarr',
        targetSchema.parse({
          id: 'tSonarr',
          label: 'Sonarr',
          widgetType: 'sonarr-queue',
          base: { host: '10.0.0.20', port: 8989 },
        }),
      ),
    )
    const text = await readFile(join(s.paths.targets, 'tSonarr.json'), 'utf8')
    expect(Object.keys(JSON.parse(text))).toEqual(['id', 'label', 'widgetType', 'base'])
  })
})

describe('writes only what changed', () => {
  it('reports no changed files for a no-op transaction', async () => {
    const s = await store()
    const result = await s.transaction('test', () => {})
    expect(result.changed).toEqual([])
  })

  it('touches one file when one entity changes', async () => {
    const s = await store()
    await s.transaction('test', (draft) => {
      draft.widgets.set('w1', widget('w1'))
      draft.widgets.set('w2', widget('w2'))
    })
    const result = await s.transaction('test', (draft) => {
      draft.widgets.set('w1', widget('w1', { title: 'Renamed' }))
    })
    expect(result.changed).toEqual([join(s.paths.widgets, 'w1.json')])
  })

  it('deletes the file when an entity is removed from the tree', async () => {
    const s = await store()
    await s.transaction('test', (draft) => draft.widgets.set('w1', widget('w1')))
    const result = await s.transaction('test', (draft) => draft.widgets.delete('w1'))
    expect(result.removed).toEqual([join(s.paths.widgets, 'w1.json')])
    expect(await readdir(s.paths.widgets)).toEqual([])
  })
})

describe('validation happens before anything is written', () => {
  it('refuses a tree with a dangling target and leaves the disk untouched', async () => {
    const s = await store()
    const before = await s.load()
    await expect(
      s.transaction('test', (draft) =>
        draft.widgets.set('bad', widget('bad', { targetId: 'tGone' })),
      ),
    ).rejects.toThrow(ConfigInvalidError)
    const after = await s.load()
    expect(after.revision).toBe(before.revision)
    expect(await readdir(s.paths.widgets)).toEqual([])
  })

  it('leaves nothing half-applied when the mutation itself throws', async () => {
    const s = await store()
    await expect(
      s.transaction('test', (draft) => {
        draft.widgets.set('w1', widget('w1'))
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await s.load()).tree.widgets.size).toBe(0)
  })
})

describe('optimistic concurrency', () => {
  it('accepts a write based on the current revision', async () => {
    const s = await store()
    const { revision } = await s.load()
    await expect(
      s.transaction('test', (draft) => draft.widgets.set('w1', widget('w1')), {
        baseRevision: revision,
      }),
    ).resolves.toBeDefined()
  })

  it('rejects a write based on a stale revision instead of clobbering', async () => {
    const s = await store()
    const stale = (await s.load()).revision
    await s.transaction('other', (draft) => draft.widgets.set('w1', widget('w1')))
    await expect(
      s.transaction('test', (draft) => draft.widgets.set('w2', widget('w2')), {
        baseRevision: stale,
      }),
    ).rejects.toThrow(ConfigConflictError)
    // And the other writer's work survived.
    expect((await s.load()).tree.widgets.has('w1')).toBe(true)
  })
})

describe('serialised writes', () => {
  it('applies concurrent transactions one at a time, losing none of them', async () => {
    const s = await store()
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.transaction('test', (draft) => draft.widgets.set(`w${i}`, widget(`w${i}`))),
      ),
    )
    const { tree } = await s.load()
    expect(tree.widgets.size).toBe(8)
  })
})

describe('resilience to hand edits', () => {
  it('names the file when JSON is malformed, rather than throwing from the boot sequence', async () => {
    const s = await store()
    await writeFile(join(s.paths.widgets, 'broken.json'), '{ "id": "broken", ')
    await expect(s.load()).rejects.toThrow(/broken\.json is not valid JSON/)
  })

  it('names the file and the field when a value violates the schema', async () => {
    const s = await store()
    await writeFile(
      join(s.paths.widgets, 'w3.json'),
      '{"id":"w3","page":"home","type":"x","poll":{"intervalMs":5}}\n',
    )
    await expect(s.load()).rejects.toThrow(/w3\.json does not match the schema/)
  })

  it('keeps unknown keys through a read/write round trip and warns instead of dropping them', async () => {
    // Someone tries a newer release, it writes a field this build has never heard of, and they
    // roll back. Losing their data silently would be the worst possible outcome.
    const s = await store()
    await writeFile(s.paths.dashboard, '{"schemaVersion":1,"futureFeature":{"enabled":true}}\n')
    const loaded = await s.load()
    expect(loaded.warnings.some((w) => w.message.includes('futureFeature'))).toBe(true)
    await s.transaction('test', (draft) => draft.widgets.set('w1', widget('w1')))
    const after = JSON.parse(await readFile(s.paths.dashboard, 'utf8'))
    expect(after.futureFeature).toEqual({ enabled: true })
  })
})

describe('audit log', () => {
  it('records who changed what, which is how an AI edit is traceable', async () => {
    const s = await store()
    await s.transaction('mcp:laptop-token', (draft) => draft.widgets.set('w1', widget('w1')))
    const lines = (await readFile(s.paths.audit, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const entry = lines.at(-1)
    expect(entry.actor).toBe('mcp:laptop-token')
    expect(entry.changed).toContain(join(s.paths.widgets, 'w1.json'))
  })

  it('does not record a transaction that changed nothing', async () => {
    const s = await store()
    const before = (await readFile(s.paths.audit, 'utf8')).split('\n').length
    await s.transaction('test', () => {})
    const after = (await readFile(s.paths.audit, 'utf8')).split('\n').length
    expect(after).toBe(before)
  })
})

describe('a fresh directory', () => {
  it('loads as an empty but valid tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neo-empty-'))
    created.push(dir)
    await mkdir(dir, { recursive: true })
    const s = new ConfigStore(dir)
    const { tree, warnings } = await s.load()
    expect(tree.dashboard.schemaVersion).toBe(1)
    expect(tree.widgets.size).toBe(0)
    expect(warnings).toEqual([])
  })
})

describe('formatting self-heals', () => {
  it('normalises a badly formatted file on the next transaction that touches the tree', async () => {
    // The change detector compares against the BYTES on disk, not against a re-render of the
    // parsed value. Comparing render-to-render would make formatting invisible forever: a file
    // left alphabetical by an older release would never be tidied, and a serialiser improvement
    // would silently never reach an existing install.
    const s = await store()
    await writeFile(
      join(s.paths.widgets, 'w1.json'),
      '{"type":"clock","page":"home","id":"w1","catalogRev":null}',
    )
    const result = await s.transaction('test', (draft) => {
      draft.widgets.set('w2', widget('w2'))
    })
    expect(result.changed).toContain(join(s.paths.widgets, 'w1.json'))

    const text = await readFile(join(s.paths.widgets, 'w1.json'), 'utf8')
    // Schema order, defaults dropped, trailing newline.
    expect(text).toBe('{\n  "id": "w1",\n  "page": "home",\n  "type": "clock"\n}\n')
  })

  it('leaves an already-canonical file alone', async () => {
    const s = await store()
    await s.transaction('test', (draft) => draft.widgets.set('w1', widget('w1')))
    const result = await s.transaction('test', (draft) => draft.widgets.set('w2', widget('w2')))
    expect(result.changed).toEqual([join(s.paths.widgets, 'w2.json')])
  })
})
