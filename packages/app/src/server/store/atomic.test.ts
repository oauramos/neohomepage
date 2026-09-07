import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileDurable, writeFilesDurable } from './atomic.ts'

const created: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neo-atomic-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

describe('writeFileDurable', () => {
  it('creates missing directories', async () => {
    const dir = await scratch()
    const path = join(dir, 'a', 'b', 'c.json')
    await writeFileDurable(path, '{"x":1}\n')
    expect(await readFile(path, 'utf8')).toBe('{"x":1}\n')
  })

  it('replaces existing contents completely, leaving no tail of the old file', async () => {
    const dir = await scratch()
    const path = join(dir, 'f.json')
    await writeFileDurable(path, `{"long":"${'x'.repeat(500)}"}\n`)
    await writeFileDurable(path, '{}\n')
    expect(await readFile(path, 'utf8')).toBe('{}\n')
  })

  it('honours an explicit mode, which is how the secrets file stays 0600', async () => {
    const dir = await scratch()
    const path = join(dir, 'secrets.json')
    await writeFileDurable(path, '{}\n', { mode: 0o600 })
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('leaves the original intact when the new contents cannot be written', async () => {
    const dir = await scratch()
    const path = join(dir, 'f.json')
    await writeFile(path, '{"original":true}\n')
    // A directory where a file should go: the write must fail without destroying what is there.
    await expect(writeFileDurable(join(dir, 'f.json', 'nested'), '{}')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{"original":true}\n')
  })
})

describe('writeFilesDurable', () => {
  it('writes every file in the batch', async () => {
    const dir = await scratch()
    const files = new Map([
      [join(dir, 'widgets', 'a.json'), '{"a":1}\n'],
      [join(dir, 'widgets', 'b.json'), '{"b":2}\n'],
      [join(dir, 'theme.json'), '{"t":3}\n'],
    ])
    await writeFilesDurable(files)
    for (const [path, contents] of files) {
      expect(await readFile(path, 'utf8')).toBe(contents)
    }
  })

  it('is not a multi-file transaction, and does not pretend to be', async () => {
    // Documented behaviour: a failure part-way leaves earlier files written. Callers get
    // all-or-nothing by validating the whole prospective tree BEFORE calling this, which is what
    // ConfigStore does — not by expecting a rollback that POSIX cannot provide.
    const dir = await scratch()
    const good = join(dir, 'good.json')
    const files = new Map([
      [good, '{"ok":true}\n'],
      [join(dir, 'good.json', 'impossible'), '{}\n'],
    ])
    await expect(writeFilesDurable(files)).rejects.toThrow()
    expect(await readFile(good, 'utf8')).toBe('{"ok":true}\n')
  })
})
