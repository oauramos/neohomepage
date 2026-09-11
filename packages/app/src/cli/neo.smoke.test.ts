import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = resolve(import.meta.dirname, 'neo.ts')
const created: string[] = []

// Runs the CLI in a real `node` child, not through vitest's transform: Node only strips types,
// so enums, parameter properties and namespaces that vitest accepts would fail here.
async function neo(args: string[], dataDir: string) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...process.env, NEOHOMEPAGE_DATA_DIR: dataDir },
  })
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neo-cli-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

describe('the CLI runs under plain node', () => {
  it('prints help', async () => {
    const { stdout } = await neo(['--help'], await scratch())
    expect(stdout).toContain('neo — neohomepage command line')
    expect(stdout).toContain('validate')
  })

  it('reports the resolved data directories', async () => {
    const dir = await scratch()
    const { stdout } = await neo(['env'], dir)
    expect(stdout).toContain(`config   ${join(dir, 'config')}`)
    expect(stdout).toContain('(never committed)')
  })

  it('initialises a valid data directory, and doing it twice changes nothing', async () => {
    const dir = await scratch()
    const first = await neo(['init'], dir)
    expect(first.stdout).toContain('.gitignore')

    const files = async () =>
      (await readdir(join(dir, 'config'), { recursive: true })).sort().join(',')
    const after = await files()

    const second = await neo(['init'], dir)
    expect(second.stdout).toContain('already seeded')
    expect(await files()).toBe(after)
  })

  it('validates a freshly initialised directory as OK', async () => {
    const dir = await scratch()
    await neo(['init'], dir)
    const { stdout } = await neo(['validate'], dir)
    expect(stdout).toContain('OK')
    expect(stdout).toContain('1 page(s)')
  })

  it('exits non-zero and names the problem when the tree is broken', async () => {
    const dir = await scratch()
    await neo(['init'], dir)
    await rm(join(dir, 'config', 'pages', 'home.json'))
    await expect(neo(['validate'], dir)).rejects.toMatchObject({ code: 1 })
  })

  it('backs up and restores through the CLI', async () => {
    const source = await scratch()
    await neo(['init'], source)
    const archive = join(source, '..', `neo-cli-archive-${Date.now()}.tar.gz`)
    created.push(archive)
    await neo(['backup', archive], source)

    const target = await scratch()
    await neo(['restore', archive], target)
    expect(await readFile(join(target, 'config', 'dashboard.json'), 'utf8')).toContain(
      'schemaVersion',
    )
    // The archive carries no secrets, so a restored install has none either.
    await expect(readdir(join(target, 'secrets'))).rejects.toThrow()
  })

  it('reports the memory environment and agrees with itself about the limit', async () => {
    const { stdout } = await neo(['runtime'], await scratch())
    expect(stdout).toContain('v8 heap limit')
    expect(stdout).toContain('effective')
  })
})
