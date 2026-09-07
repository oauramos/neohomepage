import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, defaultArchiveName, restore } from './backup.ts'
import { seedDataDirectory } from './seed.ts'

const run = promisify(execFile)
const created: string[] = []

async function dataDir() {
  const root = await mkdtemp(join(tmpdir(), 'neo-backup-'))
  created.push(root)
  const paths = {
    dataDir: root,
    configDir: join(root, 'config'),
    assetsDir: join(root, 'assets'),
    secretsDir: join(root, 'secrets'),
    stateDir: join(root, 'state'),
  }
  await seedDataDirectory(paths)
  await writeFile(join(paths.configDir, 'dashboard.json'), '{"schemaVersion":1}\n')
  await writeFile(join(paths.assetsDir, 'bg.txt'), 'pretend image\n')
  await writeFile(join(paths.secretsDir, 'secrets.json'), '{"sonarr.apiKey":"SUPERSECRET"}\n')
  await mkdir(join(paths.stateDir, 'generations'), { recursive: true })
  await writeFile(join(paths.stateDir, 'generations', 'CURRENT'), '3\n')
  return paths
}

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

describe('seeding', () => {
  it('excludes secrets/ and state/ before anything can be committed', async () => {
    const paths = await dataDir()
    const ignore = await readFile(join(paths.dataDir, '.gitignore'), 'utf8')
    expect(ignore).toMatch(/^secrets\/$/m)
    expect(ignore).toMatch(/^state\/$/m)
    expect(ignore).toMatch(/^config\/overrides\.local\.json$/m)
  })

  it('creates the secrets directory 0700, not just the files inside it', async () => {
    // A world-readable directory of 0600 files still leaks the name of every service you run.
    const paths = await dataDir()
    expect((await stat(paths.secretsDir)).mode & 0o777).toBe(0o700)
  })

  it('never overwrites files the user may have edited', async () => {
    const paths = await dataDir()
    await writeFile(join(paths.dataDir, '.gitignore'), 'mine\n')
    const written = await seedDataDirectory(paths)
    expect(written).toEqual([])
    expect(await readFile(join(paths.dataDir, '.gitignore'), 'utf8')).toBe('mine\n')
  })

  it('makes `git init && git add -A` leave secrets and state untracked', async () => {
    const paths = await dataDir()
    await run('git', ['init', '-q'], { cwd: paths.dataDir })
    await run('git', ['add', '-A'], { cwd: paths.dataDir })
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: paths.dataDir })
    const staged = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3))
    expect(staged).toContain('config/dashboard.json')
    expect(staged).toContain('assets/bg.txt')
    expect(staged.some((p) => p.startsWith('secrets/'))).toBe(false)
    expect(staged.some((p) => p.startsWith('state/'))).toBe(false)
  })
})

describe('backup', () => {
  it('archives config and assets, and structurally cannot include secrets', async () => {
    const paths = await dataDir()
    const archive = join(paths.dataDir, '..', defaultArchiveName(new Date('2026-09-06T12:00:00Z')))
    created.push(archive)
    const result = await backup({ dataDir: paths.dataDir, archive })
    expect(result.included.sort()).toEqual(['assets', 'config'])

    const { stdout } = await run('tar', ['-tzf', archive])
    expect(stdout).toMatch(/config\/dashboard\.json/)
    expect(stdout).toMatch(/assets\/bg\.txt/)
    expect(stdout).not.toMatch(/secrets/)
    expect(stdout).not.toMatch(/state/)
    expect(stdout).not.toMatch(/overrides\.local\.json/)
  })

  it('round-trips into an empty directory', async () => {
    const source = await dataDir()
    const archive = join(source.dataDir, '..', 'roundtrip.tar.gz')
    created.push(archive)
    await backup({ dataDir: source.dataDir, archive })

    const target = await mkdtemp(join(tmpdir(), 'neo-restored-'))
    created.push(target)
    const result = await restore({ archive, dataDir: target })
    expect(await readFile(join(target, 'config', 'dashboard.json'), 'utf8')).toBe(
      '{"schemaVersion":1}\n',
    )
    expect(result.entries.some((e) => e.startsWith('config/'))).toBe(true)
  })
})

describe('restore refuses a hostile archive', () => {
  it('rejects an entry that escapes the data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neo-evil-'))
    created.push(root)
    await mkdir(join(root, 'src', 'config'), { recursive: true })
    await writeFile(join(root, 'src', 'config', 'ok.json'), '{}\n')
    const archive = join(root, 'evil.tar.gz')
    // `tar` itself will happily create this; the check has to happen before extraction.
    await run('tar', ['-czf', archive, '-C', join(root, 'src'), 'config', '../src'])
    await expect(restore({ archive, dataDir: join(root, 'out') })).rejects.toThrow(
      /escapes the data directory/,
    )
  })

  it('rejects an archive that would write outside config/ and assets/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neo-evil2-'))
    created.push(root)
    await mkdir(join(root, 'src', 'secrets'), { recursive: true })
    await writeFile(join(root, 'src', 'secrets', 'secrets.json'), '{"stolen":true}\n')
    const archive = join(root, 'evil.tar.gz')
    await run('tar', ['-czf', archive, '-C', join(root, 'src'), 'secrets'])
    await expect(restore({ archive, dataDir: join(root, 'out') })).rejects.toThrow(
      /may only write config\/ and assets\//,
    )
  })
})
