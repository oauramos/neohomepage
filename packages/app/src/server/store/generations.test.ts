import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Generations } from './generations.ts'

const created: string[] = []

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'neo-gen-'))
  created.push(root)
  const configDir = join(root, 'config')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'dashboard.json'), '{"schemaVersion":1}\n')
  return { generations: new Generations(join(root, 'state')), configDir }
}

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

describe('cutting', () => {
  it('numbers generations from 1 and moves the pointer', async () => {
    const { generations, configDir } = await scratch()
    expect(await generations.current()).toBeNull()

    const first = await generations.cut({ configDir, configRevision: 'aaa', actor: 'ui' })
    expect(first.generation).toBe(1)
    expect(await generations.current()).toBe(1)

    const second = await generations.cut({ configDir, configRevision: 'bbb', actor: 'ui' })
    expect(second.generation).toBe(2)
    expect(await generations.current()).toBe(2)
  })

  it('writes the pointer as text, not a symlink, because NAS volumes handle symlinks badly', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({ configDir, configRevision: 'aaa', actor: 'ui' })
    expect(await readFile(generations.pointer, 'utf8')).toBe('1\n')
  })

  it('snapshots the config tree', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({ configDir, configRevision: 'aaa', actor: 'ui' })
    const snapshot = await readFile(join(generations.path(1), 'config', 'dashboard.json'), 'utf8')
    expect(snapshot).toBe('{"schemaVersion":1}\n')
  })

  it('excludes per-machine overrides and the audit log from the snapshot', async () => {
    // overrides.local.json is gitignored and machine-specific: restoring someone's laptop URLs
    // onto the NAS would be a regression, not a restore.
    const { generations, configDir } = await scratch()
    await writeFile(join(configDir, 'overrides.local.json'), '{"laptop":true}\n')
    await writeFile(join(configDir, '.audit.jsonl'), '{"ts":"x"}\n')
    await generations.cut({ configDir, configRevision: 'aaa', actor: 'ui' })
    const files = await readdir(join(generations.path(1), 'config'))
    expect(files).toEqual(['dashboard.json'])
  })

  it('records who cut it and from which revision', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({
      configDir,
      configRevision: 'rev1',
      actor: 'mcp:token',
      label: 'add pihole',
    })
    const meta = await generations.meta(1)
    expect(meta).toMatchObject({ actor: 'mcp:token', configRevision: 'rev1', label: 'add pihole' })
  })
})

describe('rollback', () => {
  it('moves the pointer without destroying the newer generation', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({ configDir, configRevision: 'a', actor: 'ui' })
    await generations.cut({ configDir, configRevision: 'b', actor: 'ui' })

    await generations.rollback(1)
    expect(await generations.current()).toBe(1)
    // Reversible: generation 2 is still there to roll forward to.
    expect(await generations.list()).toEqual([1, 2])
    await generations.rollback(2)
    expect(await generations.current()).toBe(2)
  })

  it('refuses a generation that does not exist, and says which do', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({ configDir, configRevision: 'a', actor: 'ui' })
    await expect(generations.rollback(9)).rejects.toThrow(/generation 9 does not exist \(have: 1\)/)
  })

  it('restores a generation back into the live config directory on request', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({ configDir, configRevision: 'a', actor: 'ui' })
    await writeFile(join(configDir, 'dashboard.json'), '{"schemaVersion":1,"title":"broken"}\n')
    await generations.restoreConfig(1, configDir)
    expect(await readFile(join(configDir, 'dashboard.json'), 'utf8')).toBe('{"schemaVersion":1}\n')
  })
})

describe('pruning', () => {
  it('keeps the newest N', async () => {
    const { generations, configDir } = await scratch()
    for (let i = 0; i < 6; i++)
      await generations.cut({ configDir, configRevision: `r${i}`, actor: 'ui' })
    await generations.prune(3)
    expect(await generations.list()).toEqual([4, 5, 6])
  })

  it('never prunes the generation currently being served', async () => {
    // Pruning the active generation is the one bug in this module that takes the site down.
    const { generations, configDir } = await scratch()
    for (let i = 0; i < 6; i++)
      await generations.cut({ configDir, configRevision: `r${i}`, actor: 'ui' })
    await generations.rollback(1)
    const removed = await generations.prune(2)
    expect(removed).not.toContain(1)
    expect(await generations.list()).toContain(1)
    expect(await generations.current()).toBe(1)
  })

  it('does nothing when there are fewer generations than the limit', async () => {
    const { generations, configDir } = await scratch()
    await generations.cut({ configDir, configRevision: 'a', actor: 'ui' })
    expect(await generations.prune(10)).toEqual([])
  })
})
