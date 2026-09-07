import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'

/**
 * The MCP surface, driven through the SDK's own in-memory transport.
 *
 * Calling the handlers directly would test the handlers; going through a real client exercises
 * schema validation, the tool listing and the result envelope — which is where the failures that
 * only appear in an agent actually live.
 */

const created: string[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let context: any
let client: Client

async function callJson(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: { type: string; text: string }[]
  }
  const text = result.content[0]?.text ?? ''
  if (result.isError === true) return { isError: true as const, text }
  return { isError: false as const, value: JSON.parse(text) as Record<string, unknown> }
}

beforeEach(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-mcp-'))
  created.push(dataDir)
  process.env.NEOHOMEPAGE_DATA_DIR = dataDir
  process.env.NEOHOMEPAGE_CATALOG_DIR = join(import.meta.dirname, '../../../../../catalog')
  vi.resetModules()

  const { env } = await import('../env.ts')
  const { seedDataDirectory } = await import('../store/seed.ts')
  const { seedStarterConfig } = await import('../store/starter.ts')
  await seedDataDirectory({
    dataDir: env.dataDir,
    configDir: env.configDir,
    assetsDir: env.assetsDir,
    secretsDir: env.secretsDir,
    stateDir: env.stateDir,
  })
  await seedStarterConfig(env.configDir)

  const { createContext } = await import('../context.ts')
  const { buildDashboardServer } = await import('./server.ts')
  context = await createContext({
    catalogDir: process.env.NEOHOMEPAGE_CATALOG_DIR,
    publishMode: 'manual',
  })
  await context.reload()

  const server = buildDashboardServer({ context, actor: 'mcp:test' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0.0.1' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client?.close()
  await context?.shutdown()
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
  delete process.env.NEOHOMEPAGE_DATA_DIR
  delete process.env.NEOHOMEPAGE_CATALOG_DIR
})

describe('the tool surface', () => {
  it('advertises a fixed set, whatever the catalog contains', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'add_target',
      'add_widget',
      'describe_dashboard',
      'get_widget_schema',
      'list_targets',
      'list_widgets',
      'publish',
      'remove_widget',
      'search_catalog',
      'set_layout',
      'test_target',
      'update_widget',
    ])
  })

  it('gives every tool an OBJECT input schema with no root-level combinator', async () => {
    // Two verified constraints in one assertion. A non-object input schema is silently dropped by
    // some SDK paths, and Claude Code flattens root-level anyOf/oneOf — merging the properties of
    // every branch, which would quietly mangle a discriminated union over widget types.
    const { tools } = await client.listTools()
    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>
      expect(schema.type, tool.name).toBe('object')
      expect(schema.anyOf, tool.name).toBeUndefined()
      expect(schema.oneOf, tool.name).toBeUndefined()
      expect(schema.allOf, tool.name).toBeUndefined()
    }
  })

  it('exposes no tool that could read a secret', async () => {
    // Tool results land in a model context that may be shipped to a third-party API, so there is
    // no read path at any scope — not a permission, an absence.
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    expect(names.some((name) => /secret|credential|password|token/i.test(name))).toBe(false)
  })

  it('exposes no tool that takes a raw URL', async () => {
    // An agent names a widget, or a host and a port. It cannot name a URL, a path, a header or a
    // method — the same invariant the browser is held to.
    const { tools } = await client.listTools()
    for (const tool of tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      )
      expect(
        properties.filter((name) => /^(url|path|header|method)$/i.test(name)),
        tool.name,
      ).toEqual([])
    }
  })
})

describe('reading', () => {
  it('describes an empty dashboard', async () => {
    const result = await callJson('describe_dashboard')
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value.pages).toHaveLength(1)
      expect(result.value.widgets).toEqual([])
      expect(typeof result.value.revision).toBe('string')
    }
  })

  it('searches the catalog and describes a type', async () => {
    const search = await callJson('search_catalog', { query: 'sonarr' })
    expect(search.isError === false && (search.value.matches as unknown[]).length).toBeGreaterThan(
      0,
    )

    const schema = await callJson('get_widget_schema', { type: 'sonarr-queue' })
    expect(schema.isError === false && schema.value.targetFields).toBeDefined()
  })

  it('returns an error result, not a crash, for an unknown type', async () => {
    const result = await callJson('get_widget_schema', { type: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.isError === true && result.text).toMatch(/search_catalog/)
  })
})

describe('writing', () => {
  it('adds a target and stores only a reference in config', async () => {
    const added = await callJson('add_target', {
      label: 'Sonarr',
      type: 'sonarr-queue',
      host: '10.0.0.20',
      port: 8989,
      secrets: { apiKey: 'AGENT-SUPPLIED-SECRET' },
    })
    expect(added.isError).toBe(false)
    const id = added.isError === false ? (added.value.id as string) : ''

    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const target = await readFile(join(dataDir, 'config', 'targets', `${id}.json`), 'utf8')
    expect(target).toContain('$secret')
    expect(target).not.toContain('AGENT-SUPPLIED-SECRET')

    // And no tool can read it back.
    const listed = await callJson('list_targets')
    expect(JSON.stringify(listed)).not.toContain('AGENT-SUPPLIED-SECRET')
  })

  it('adds a widget and places it the same way the editor would', async () => {
    const added = await callJson('add_widget', { type: 'sonarr-queue' })
    expect(added.isError).toBe(false)
    const id = added.isError === false ? (added.value.id as string) : ''

    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const layout = JSON.parse(
      await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8'),
    ) as { layouts: Record<string, { i: string; x: number; y: number }[]> }
    // First widget on an empty board goes to the origin — the same first-fit result a person
    // clicking "add" gets, because it is literally the same function.
    expect(layout.layouts.lg?.[0]).toMatchObject({ i: id, x: 0, y: 0 })
  })

  it('merges config on update rather than replacing it', async () => {
    const added = await callJson('add_widget', { type: 'sonarr-queue', config: { maxItems: 5 } })
    const id = added.isError === false ? (added.value.id as string) : ''
    await callJson('update_widget', { id, title: 'Renamed' })

    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const widget = JSON.parse(
      await readFile(join(dataDir, 'config', 'widgets', `${id}.json`), 'utf8'),
    ) as { title: string; config: Record<string, unknown> }
    expect(widget.title).toBe('Renamed')
    expect(widget.config).toEqual({ maxItems: 5 })
  })

  it('refuses a stale baseRevision instead of clobbering a concurrent edit', async () => {
    const before = await callJson('describe_dashboard')
    const stale = before.isError === false ? (before.value.revision as string) : ''

    await callJson('add_widget', { type: 'sonarr-queue' })
    const conflicted = await callJson('add_widget', { type: 'sonarr-queue', baseRevision: stale })
    expect(conflicted.isError).toBe(true)
    expect(conflicted.isError === true && conflicted.text).toMatch(/changed underneath/)
  })

  it('removes a widget and its layout entries', async () => {
    const added = await callJson('add_widget', { type: 'sonarr-queue' })
    const id = added.isError === false ? (added.value.id as string) : ''
    await callJson('remove_widget', { id })

    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const layout = await readFile(join(dataDir, 'config', 'layouts', 'home.json'), 'utf8')
    expect(layout).not.toContain(id)
  })

  it('refuses a blocked address even with a valid-looking credential', async () => {
    // The credential is supplied deliberately: without one the request fails on the missing
    // credential first and never reaches the address check, so the earlier version of this test
    // was passing for the wrong reason and proving nothing about egress.
    const result = await callJson('test_target', {
      type: 'sonarr-queue',
      host: '169.254.169.254',
      port: 80,
      secrets: { apiKey: 'anything' },
    })
    expect(result.isError === false && result.value).toMatchObject({
      reachable: false,
      code: 'blocked-address',
    })
  })

  it('fails on a missing credential before it dials anything', async () => {
    const result = await callJson('test_target', {
      type: 'sonarr-queue',
      host: '10.0.0.20',
      port: 8989,
    })
    expect(result.isError === false && result.value).toMatchObject({
      reachable: false,
      code: 'missing-credential',
    })
  })
})

describe('attribution', () => {
  it('records the agent as the actor, so its edits are traceable', async () => {
    await callJson('add_widget', { type: 'sonarr-queue' })
    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const audit = await readFile(join(dataDir, 'config', '.audit.jsonl'), 'utf8')
    expect(audit).toContain('"actor":"mcp:test"')
  })
})

describe('composite widget types', () => {
  it('describes the roles an agent has to fill', async () => {
    const result = await callJson('get_widget_schema', { type: 'unified-calendar' })
    expect(result.isError).toBe(false)
    const schema = (result as { value: Record<string, unknown> }).value as unknown as {
      shape: string
      roles: { name: string; min: number; kinds: { name: string }[] }[]
    }
    expect(schema.shape).toBe('composite')
    expect(schema.roles[0]?.name).toBe('calendars')
    expect(schema.roles[0]?.kinds.map((kind) => kind.name).sort()).toEqual([
      'ics-feed',
      'lidarr-albums',
      'radarr-queue',
      'sonarr-queue',
    ])
  })

  it('refuses to create one with an unfilled role', async () => {
    // A tile bound to nothing that reports success is worse than an error: the agent moves on and
    // the user finds an empty widget later with no explanation.
    const result = await callJson('add_widget', { type: 'unified-calendar' })
    expect(result.isError).toBe(true)
    expect(result.isError === true ? result.text : '').toMatch(/role "calendars"/)
  })

  it('creates one when the role is filled', async () => {
    const target = await callJson('add_target', {
      label: 'Bins',
      type: 'ics-feed',
      host: '10.0.0.9',
      port: 5232,
      basePath: '/bins.ics',
    })
    expect(target.isError).toBe(false)
    const targetId = (target as { value: { id: string } }).value.id

    const created = await callJson('add_widget', {
      type: 'unified-calendar',
      bindings: { calendars: [targetId] },
    })
    expect(created.isError).toBe(false)
    const widgetId = (created as { value: { id: string } }).value.id

    const listed = await callJson('list_widgets')
    const widgets = (listed as { value: { widgets: { id: string; type: string }[] } }).value.widgets
    expect(widgets.find((one) => one.id === widgetId)?.type).toBe('unified-calendar')
  })
})
