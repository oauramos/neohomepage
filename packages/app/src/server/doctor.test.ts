import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { manifestSchema, type Manifest } from '@neohomepage/catalog-schema'
import { runDoctor, type DoctorInput, type Finding } from './doctor.ts'
import {
  dashboardSchema,
  networkSchema,
  targetSchema,
  themeSchema,
  widgetSchema,
} from './config/schema.ts'
import type { ConfigTree } from './store/tree.ts'
import type { Env } from './env.ts'

const exec = promisify(execFile)
const created: string[] = []

let dataDir = ''
let env: Env

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'neo-doctor-'))
  created.push(dataDir)
  env = {
    dataDir,
    configDir: join(dataDir, 'config'),
    assetsDir: join(dataDir, 'assets'),
    secretsDir: join(dataDir, 'secrets'),
    stateDir: join(dataDir, 'state'),
    catalogDir: join(dataDir, 'catalog'),
    host: '127.0.0.1',
    port: 7575,
  }
  for (const dir of [env.configDir, env.assetsDir, env.secretsDir, env.stateDir]) {
    await mkdir(dir, { recursive: true })
  }
})

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

const sonarr: Manifest = manifestSchema.parse({
  manifestVersion: 1,
  id: 'sonarr-queue',
  version: '1.0.0',
  displayName: 'Sonarr',
  category: 'media-automation',
  icon: 'sonarr',
  target: {
    fields: [{ name: 'apiKey', kind: 'secret', label: 'API key', required: true }],
    auth: { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' },
  },
  config: [],
  operations: { queue: { method: 'GET', path: '/api/v3/queue', decode: 'json' } },
  projection: { op: 'get', path: '$' },
  presentation: { template: 'list' },
  poll: { defaultIntervalMs: 60_000, minIntervalMs: 15_000 },
  requires: { templates: ['list'], opcodes: ['get'], authKinds: ['header'], fetchKinds: ['json'] },
})

function tree(overrides: Partial<ConfigTree> = {}): ConfigTree {
  return {
    dashboard: dashboardSchema.parse({ schemaVersion: 1 }),
    pages: new Map(),
    layouts: new Map(),
    targets: new Map(),
    widgets: new Map(),
    theme: themeSchema.parse({}),
    network: networkSchema.parse({}),
    ...overrides,
  }
}

const target = (overrides: Record<string, unknown> = {}) =>
  targetSchema.parse({
    id: 't1',
    label: 'Sonarr',
    widgetType: 'sonarr-queue',
    base: { host: '10.0.0.20', port: 8989 },
    secrets: { apiKey: { $secret: 't1.apiKey' } },
    ...overrides,
  })

const widget = (overrides: Record<string, unknown> = {}) =>
  widgetSchema.parse({ id: 'w1', page: 'home', type: 'sonarr-queue', targetId: 't1', ...overrides })

async function check(overrides: Partial<DoctorInput> = {}): Promise<Finding[]> {
  return runDoctor({
    env,
    tree: tree(),
    catalog: new Map([['sonarr-queue', sonarr]]),
    hasSecret: () => true,
    storedNames: new Set(),
    diagnostics: [],
    ...overrides,
  })
}

const codes = (findings: readonly Finding[]) => findings.map((one) => one.code)

describe('credentials', () => {
  it('names a missing credential AND the target that wants it', async () => {
    const findings = await check({
      tree: tree({ targets: new Map([['t1', target()]]), widgets: new Map([['w1', widget()]]) }),
      hasSecret: () => false,
    })
    const missing = findings.find((one) => one.code === 'missing-credential')
    expect(missing?.message).toContain('t1.apiKey')
    expect(missing?.message).toContain('Sonarr')
    expect(missing?.message).toContain('apiKey')
    expect(missing?.fix).toContain('NEOHOMEPAGE_SECRET_T1_APIKEY')
  })

  it('is satisfied by a credential that only exists in the environment', async () => {
    const findings = await check({
      tree: tree({ targets: new Map([['t1', target()]]), widgets: new Map([['w1', widget()]]) }),
      hasSecret: (name) => name === 't1.apiKey',
    })
    expect(codes(findings)).not.toContain('missing-credential')
  })

  it('reports a stored credential nothing references', async () => {
    const findings = await check({ storedNames: new Set(['old.apiKey']) })
    expect(codes(findings)).toContain('orphan-credential')
  })
})

describe('widgets and targets', () => {
  it('reports a widget whose type left the catalog', async () => {
    const findings = await check({
      tree: tree({ widgets: new Map([['w1', widget({ type: 'gone' })]]) }),
    })
    expect(codes(findings)).toContain('unknown-widget-type')
  })

  it('reports a widget pointing at a target that does not exist', async () => {
    const findings = await check({ tree: tree({ widgets: new Map([['w1', widget()]]) }) })
    expect(codes(findings)).toContain('missing-target')
  })

  it('reports a target no widget uses, because its credential is still on disk', async () => {
    const findings = await check({ tree: tree({ targets: new Map([['t1', target()]]) }) })
    expect(codes(findings)).toContain('orphan-target')
  })

  it('reports a credential sitting in config as a plain field, and says to rotate it', async () => {
    const findings = await check({
      tree: tree({
        targets: new Map([['t1', target({ fields: { apiKey: 'leaked' } })]]),
        widgets: new Map([['w1', widget()]]),
      }),
    })
    const leak = findings.find((one) => one.code === 'credential-in-config')
    expect(leak?.severity).toBe('error')
    expect(leak?.fix).toMatch(/ROTATE/)
  })
})

describe('schema version', () => {
  it('refuses config from a newer build rather than letting it be corrupted', async () => {
    const findings = await check({
      tree: tree({
        dashboard: {
          ...dashboardSchema.parse({ schemaVersion: 1 }),
          schemaVersion: 9,
        } as unknown as ConfigTree['dashboard'],
      }),
    })
    const finding = findings.find((one) => one.code === 'config-from-the-future')
    expect(finding?.severity).toBe('error')
  })
})

describe('git hygiene', () => {
  it('says nothing when the data directory is not a repository', async () => {
    expect(codes(await check())).not.toContain('secrets-tracked')
  })

  it('catches secrets/ and state/ being tracked, and says to rotate', async () => {
    await exec('git', ['init', '-q'], { cwd: dataDir })
    await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dataDir })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: dataDir })
    await writeFile(join(env.secretsDir, 'secrets.json'), '{"a":"b"}\n')
    await writeFile(join(env.stateDir, 'resolved.json'), '{}\n')
    await exec('git', ['add', '-A', '-f'], { cwd: dataDir })
    await exec('git', ['commit', '-q', '-m', 'oops'], { cwd: dataDir })

    const findings = await check()
    expect(codes(findings)).toContain('secrets-tracked')
    expect(codes(findings)).toContain('state-tracked')
    expect(findings.find((one) => one.code === 'secrets-tracked')?.fix).toMatch(/ROTATE/)
  })
})

describe('assets', () => {
  it('warns about a wallpaper that git will carry forever', async () => {
    await mkdir(join(env.assetsDir, 'backgrounds'), { recursive: true })
    await writeFile(join(env.assetsDir, 'backgrounds', 'huge.webp'), Buffer.alloc(3 * 1024 * 1024))
    const findings = await check()
    const large = findings.find((one) => one.code === 'large-asset')
    expect(large?.message).toContain('3.0 MB')
    expect(large?.fix).toContain('committed forever')
  })
})

describe('a healthy install', () => {
  it('finds nothing at all', async () => {
    const findings = await check({
      tree: tree({ targets: new Map([['t1', target()]]), widgets: new Map([['w1', widget()]]) }),
    })
    expect(findings).toEqual([])
  })
})
