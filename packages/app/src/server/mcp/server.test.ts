import type { Resolved } from '../../shared/resolved.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
      'add_bookmark',
      'add_target',
      'add_widget',
      'describe_dashboard',
      'describe_theme',
      'get_sections',
      'get_widget_schema',
      'list_targets',
      'list_widgets',
      'publish',
      'remove_widget',
      'search_catalog',
      'search_presets',
      'set_layout',
      'set_sections',
      'set_theme',
      'test_target',
      'update_widget',
    ])
  })

  it('exports that same list, so --print-tools cannot go stale', async () => {
    // `TOOL_NAMES` is what `neo mcp --print-tools` reports and what the docs are written from,
    // and nothing connected it to the tools actually registered: adding one and forgetting the
    // array left the CLI confidently naming a surface that was three tools short.
    const { TOOL_NAMES } = await import('./server.ts')
    const { tools } = await client.listTools()
    expect([...TOOL_NAMES].sort()).toEqual(tools.map((tool) => tool.name).sort())
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
      // A bookmark's path is where the VIEWER'S browser goes when the link is clicked; the server
      // never fetches it, so it is the one path that is not a request leaving the box.
      const allowed = tool.name === 'add_bookmark' ? ['path'] : []
      expect(
        properties.filter(
          (name) => /^(url|path|header|method)$/i.test(name) && !allowed.includes(name),
        ),
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

/**
 * The design surface.
 *
 * These tools exist so "make it look like that site" is a thing an agent can do, which means a
 * palette now arrives from outside the repository for the first time. Most of what follows is
 * about that: what happens to a colour on the way in, what happens when the colours a brand
 * publishes cannot be read on a dashboard, and what the tool says it did.
 */

const themeFile = async () =>
  JSON.parse(
    await readFile(
      join(process.env.NEOHOMEPAGE_DATA_DIR as string, 'config', 'theme.json'),
      'utf8',
    ),
  ) as {
    mode?: string
    preset?: string
    cssVars?: {
      theme?: Record<string, string>
      light?: Record<string, string>
      dark?: Record<string, string>
    }
    surface?: { background?: string | null; blur?: number; overlayOpacity?: number }
  }

/** The colours Apple publishes, which is the request this whole surface was built for. */
const APPLE_LIGHT = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  surface: '#ffffff',
  'surface-foreground': '#1d1d1f',
  muted: '#f5f5f7',
  'muted-foreground': '#86868b',
  accent: '#0071e3',
  'accent-foreground': '#ffffff',
}

describe('reading the look', () => {
  it('describes a stock board without inventing a scheme it cannot know', async () => {
    const result = await callJson('describe_theme')
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.mode).toBe('system')
    // Under "system" the page carries both palettes and the viewer's OS chooses. A server that
    // reported one "effective scheme" would be guessing, and an agent would then write into it.
    expect(result.value.modeNote).toMatch(/both palettes/)
    expect((result.value.palette as Record<string, Record<string, string>>).light?.accent).toMatch(
      /^#[0-9a-f]{6}$/,
    )
    expect((result.value.contrast as Record<string, { passes: boolean }>).light?.passes).toBe(true)
    expect((result.value.contrast as Record<string, { passes: boolean }>).dark?.passes).toBe(true)
    // The labels are what stop an agent putting a brand's page grey on `muted`, which is an inset.
    expect(JSON.stringify(result.value.colorTokens)).toMatch(/muted — Inset/)
  })

  it('searches seventy-five presets by name and by finish', async () => {
    const all = await callJson('search_presets')
    expect(all.isError === false && all.value.total).toBe(75)
    const soft = await callJson('search_presets', { finish: 'soft', limit: 5 })
    expect(soft.isError).toBe(false)
    if (soft.isError) return
    const matches = soft.value.matches as { id: string; swatch: Record<string, string> }[]
    expect(matches).toHaveLength(5)
    expect(matches.every((preset) => preset.id.endsWith('-soft'))).toBe(true)
    expect(matches[0]?.swatch.accent).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('changing the look', () => {
  it('stores a hex colour as OKLCH, in the scheme it was given for', async () => {
    const result = await callJson('set_theme', { colors: { light: { accent: '#0071e3' } } })
    expect(result.isError).toBe(false)

    const theme = await themeFile()
    // Hex would make every ratio in the panel and in the contrast suite come back null, so the
    // conversion happens on the way in and the file only ever holds the checkable form.
    expect(theme.cssVars?.light?.accent).toMatch(/^oklch\(/)
    expect(JSON.stringify(theme)).not.toContain('#0071e3')
    expect(theme.cssVars?.dark?.accent).toBeUndefined()
  })

  it('sets both palettes in one transaction, because the OS picks one', async () => {
    const result = await callJson('set_theme', {
      mode: 'system',
      colors: { light: APPLE_LIGHT, dark: { accent: '#2997ff', background: '#000000' } },
    })
    expect(result.isError).toBe(false)
    const theme = await themeFile()
    expect(Object.keys(theme.cssVars?.light ?? {}).length).toBeGreaterThan(5)
    expect(theme.cssVars?.dark?.accent).toMatch(/^oklch\(/)
  })

  it('keeps a brand palette readable and says which colours it moved', async () => {
    const result = await callJson('set_theme', { colors: { light: APPLE_LIGHT } })
    expect(result.isError).toBe(false)
    if (result.isError) return

    const adjusted = result.value.adjusted as {
      token: string
      from: string
      to: string
      why: string
    }[]
    // `#86868b` on `#f5f5f7` is 3.1:1. A brand picks it for a wordmark, not for a 4.5:1 floor on
    // an inset grey, so the label darkens — and the report says by how much and why.
    expect(adjusted.map((entry) => entry.token)).toContain('muted-foreground')
    expect(adjusted.every((entry) => /:1, below/.test(entry.why))).toBe(true)
    expect((result.value.contrast as Record<string, { passes: boolean }>).light?.passes).toBe(true)
  })

  it('writes the palette untouched when told not to fit it', async () => {
    const result = await callJson('set_theme', { colors: { light: APPLE_LIGHT }, fit: 'off' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.adjusted).toEqual([])
    // The verdict is still reported. "Off" means it does not repair, not that it stops looking.
    expect((result.value.contrast as Record<string, { passes: boolean }>).light?.passes).toBe(false)
  })

  it('refuses an unreadable palette outright when asked to', async () => {
    const result = await callJson('set_theme', {
      colors: { light: { ...APPLE_LIGHT, foreground: '#eeeeee' } },
      fit: 'refuse',
    })
    expect(result.isError).toBe(true)
    expect(result.isError === true && result.text).toMatch(/does not read/)
    const theme = await themeFile()
    expect(theme.cssVars?.light?.foreground).toBeUndefined()
  })

  it('previews without writing anything', async () => {
    const before = await themeFile()
    const result = await callJson('set_theme', {
      preset: 'nord',
      colors: { light: APPLE_LIGHT },
      dryRun: true,
    })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.dryRun).toBe(true)
    expect(result.value.revision).toBeUndefined()
    // Same code path as the write, so what it shows is what a write would do — and nothing landed.
    expect(result.value.preset).toBe('nord')
    expect(await themeFile()).toEqual(before)
  })

  it('unpins a colour from the shared bucket so the write is visible', async () => {
    // `cssVars.theme` resolves LAST, above both schemes. A colour pinned there — which the theme
    // import box can do — made every later colour write a silent no-op: the caller asked for blue,
    // the board stayed red, and the tool reported success.
    await callJson('set_theme', { colors: { light: { accent: '#ff0000' } } })
    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const path = join(dataDir, 'config', 'theme.json')
    const pinned = JSON.parse(await readFile(path, 'utf8')) as Record<string, never>
    const shared = {
      ...pinned,
      cssVars: { theme: { accent: 'oklch(0.5 0.2 27)' }, light: {}, dark: {} },
    }
    await writeFile(path, JSON.stringify(shared, null, 2))
    await context.reload()

    const result = await callJson('set_theme', { colors: { light: { accent: '#0071e3' } } })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.applied).toMatchObject({ unpinned: ['accent'] })
    const theme = await themeFile()
    expect(theme.cssVars?.theme?.accent).toBeUndefined()
  })

  it('puts one token back without touching the others', async () => {
    await callJson('set_theme', { colors: { light: { accent: '#0071e3', ok: '#00aa55' } } })
    await callJson('set_theme', { colors: { light: { accent: null } } })
    const theme = await themeFile()
    expect(theme.cssVars?.light?.accent).toBeUndefined()
    expect(theme.cssVars?.light?.ok).toMatch(/^oklch\(/)
  })

  it('resets a whole section, and never the preset or the mode', async () => {
    await callJson('set_theme', {
      preset: 'nord',
      mode: 'dark',
      colors: { dark: { accent: '#0071e3' } },
      shape: { radius: 4 },
    })
    const result = await callJson('set_theme', { reset: ['colors'] })
    expect(result.isError).toBe(false)
    const theme = await themeFile()
    expect(theme.cssVars?.dark?.accent).toBeUndefined()
    expect(theme.cssVars?.theme?.radius).toBe('4px')
    expect(theme.preset).toBe('nord')
    expect(theme.mode).toBe('dark')
  })

  it('applies shape and type as the panel does, tracking the control radius', async () => {
    await callJson('set_theme', {
      shape: { radius: 20, borderWidth: 2, boardWidth: 'narrow' },
      typography: { font: 'serif', titleCase: 'sentence' },
    })
    const theme = await themeFile()
    expect(theme.cssVars?.theme).toMatchObject({
      radius: '20px',
      'radius-control': '14px',
      'border-width': '2px',
      'max-width': '1200px',
      'title-transform': 'none',
      'title-tracking': '0',
    })
    expect(theme.cssVars?.theme?.['font-sans']).toContain('ui-serif')
  })

  it('takes a backdrop by name and the preset brings its own', async () => {
    await callJson('set_theme', { backdrop: 'aurora', backdropBlur: 8, backdropDim: 0.3 })
    expect((await themeFile()).surface).toMatchObject({
      background: 'gradient:aurora',
      blur: 8,
      overlayOpacity: 0.3,
    })
    // The console presets nominate their own, exactly as picking one in the panel does.
    await callJson('set_theme', { preset: '32bit' })
    expect((await themeFile()).surface?.background).toBe('gradient:neogeo-scan')
  })

  it('refuses a stale baseRevision here too', async () => {
    const before = await callJson('describe_theme')
    const stale = before.isError === false ? (before.value.revision as string) : ''
    await callJson('set_theme', { preset: 'nord' })
    const conflicted = await callJson('set_theme', { preset: 'terminal', baseRevision: stale })
    expect(conflicted.isError).toBe(true)
    expect(conflicted.isError === true && conflicted.text).toMatch(/changed underneath/)
  })
})

describe('what a repair may not do', () => {
  it('does not rewrite colours when the call only reset the shape', async () => {
    await callJson('set_theme', { colors: { light: { accent: '#0071e3' } } })
    const before = (await themeFile()).cssVars?.light ?? {}
    await callJson('set_theme', { reset: ['shape'] })
    // A request to put the corner radius back should not come out having pinned palette
    // overrides: the repair pass runs on a colour change, not on any change at all.
    expect((await themeFile()).cssVars?.light).toEqual(before)
  })

  it('answers a standalone fit call instead of calling it nothing', async () => {
    // "Check the palette and repair it" is a request. Answering it with "nothing to change"
    // made the same call succeed or fail depending on state the caller could not see.
    const result = await callJson('set_theme', { fit: 'aa' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect((result.value.contrast as Record<string, { passes: boolean }>).light?.passes).toBe(true)
  })

  it('clears the shared-bucket pin as well, or "back to the preset" is not back', async () => {
    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const path = join(dataDir, 'config', 'theme.json')
    await writeFile(
      path,
      JSON.stringify({ cssVars: { theme: { accent: 'oklch(0.5 0.2 27)' }, light: {}, dark: {} } }),
    )
    await context.reload()

    await callJson('set_theme', { colors: { light: { accent: null } } })
    const theme = await themeFile()
    expect(theme.cssVars?.theme?.accent).toBeUndefined()
  })

  it('unpins what it repairs, or it reports a fix the board never shows', async () => {
    // The fit is solved from the RESOLVED palette, so a token pinned in the shared bucket is what
    // it measured. Writing the repair into the scheme bucket and leaving the pin would have
    // printed a ratio for a colour that never reached the page.
    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    await writeFile(
      join(dataDir, 'config', 'theme.json'),
      JSON.stringify({
        cssVars: { theme: { 'muted-foreground': 'oklch(0.9 0 0)' }, light: {}, dark: {} },
      }),
    )
    await context.reload()

    const result = await callJson('set_theme', { fit: 'aa' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect((result.value.applied as { unpinned?: string[] }).unpinned).toContain('muted-foreground')
    expect((await themeFile()).cssVars?.theme?.['muted-foreground']).toBeUndefined()
    expect((result.value.contrast as Record<string, { passes: boolean }>).light?.passes).toBe(true)
  })

  it('paints a preset that overrides nothing with the colours it actually gets', async () => {
    // "Default" sets no colour of its own — it IS the defaults — so reading its own maps reported
    // a palette of five nulls to anyone browsing the presets.
    const result = await callJson('search_presets', { query: 'default' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    const swatch = (result.value.matches as { swatch: Record<string, string> }[])[0]?.swatch
    expect(Object.values(swatch ?? {}).every((hex) => /^#[0-9a-f]{6}$/.test(hex))).toBe(true)
  })

  it('takes an image that exists and stores the path itself', async () => {
    const dataDir = process.env.NEOHOMEPAGE_DATA_DIR as string
    const { saveBackground } = await import('../assets/store.ts')
    // A one-pixel PNG, so the store sniffs a real type from real magic bytes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const asset = await saveBackground(join(dataDir, 'assets'), png)

    const result = await callJson('set_theme', { backdropImage: asset.id })
    expect(result.isError).toBe(false)
    // The caller names an id; the path is built here, so there is no input that reaches the
    // filesystem or the url() in the published stylesheet.
    expect((await themeFile()).surface?.background).toBe(`/assets/backgrounds/${asset.id}`)
  })
})

describe('what the design tools refuse', () => {
  it.each([
    ['a CSS value', { colors: { light: { accent: 'red' } } }, /not a colour/],
    [
      'a smuggled declaration',
      { colors: { light: { accent: '#fff;background:url(x)' } } },
      /not a colour/,
    ],
    [
      'a token that does not exist',
      { colors: { light: { primary: '#0071e3' } } },
      /not a colour token/,
    ],
    ['a preset nobody ships', { preset: 'apple' }, /no preset "apple"/],
    ['a backdrop nobody ships', { backdrop: 'parallax' }, /Invalid option/],
    [
      'an image that was never uploaded',
      { backdropImage: 'a'.repeat(32) + '.png' },
      /design panel/,
    ],
    ['a reset of something it does not own', { reset: ['everything'] }, /cannot reset/],
    // A plain object would have found Object.prototype.toString here and tried to iterate it.
    ['a reset naming a property of every object', { reset: ['toString'] }, /cannot reset/],
    ['a call that names nothing at all', {}, /nothing to change/],
  ])('%s', async (_label, args, expected) => {
    const result = await callJson('set_theme', args as Record<string, unknown>)
    expect(result.isError).toBe(true)
    expect(result.isError === true && result.text).toMatch(expected)
  })

  it('leaves the theme untouched when it refuses', async () => {
    const before = await themeFile()
    await callJson('set_theme', { colors: { light: { accent: 'red' } } })
    expect(await themeFile()).toEqual(before)
  })

  it('has no way to add an image, only to choose one', async () => {
    const { tools } = await client.listTools()
    const design = tools.filter((tool) => /theme|preset/.test(tool.name))
    expect(design).toHaveLength(3)
    for (const tool of design) {
      const schema = JSON.stringify(tool.inputSchema)
      expect(schema, tool.name).not.toMatch(/"(url|path|href|src|data|bytes|content)"/)
    }
  })
})

describe('sections', () => {
  it('reports the implicit pair, replaces them whole, and refuses to strand a widget', async () => {
    const before = await callJson('get_sections')
    expect(before.isError).toBe(false)
    if (!before.isError) {
      expect((before.value.sections as { kind: string }[]).map((s) => s.kind)).toEqual([
        'navbar',
        'grid',
      ])
    }

    const set = await callJson('set_sections', {
      page: 'home',
      sections: [
        { id: 'main', kind: 'grid' },
        { id: 'side', kind: 'grid', cols: { lg: 6 } },
      ],
    })
    expect(set.isError).toBe(false)

    const added = await callJson('add_widget', { type: 'sonarr-queue', section: 'side' })
    expect(added.isError).toBe(false)

    const strand = await callJson('set_sections', {
      page: 'home',
      sections: [{ id: 'main', kind: 'grid' }],
    })
    expect(strand.isError).toBe(true)
    if (strand.isError) expect(strand.text).toContain('side')

    const described = await callJson('describe_dashboard')
    if (!described.isError) {
      const page = (
        described.value.pages as { sections: { id: string; widgets?: string[] }[] }[]
      )[0]
      expect(page?.sections.find((s) => s.id === 'side')?.widgets).toHaveLength(1)
    }
  })

  it('adds a bookmark from parts, creating the group by title', async () => {
    await callJson('set_sections', {
      page: 'home',
      sections: [
        { id: 'main', kind: 'grid' },
        { id: 'links', kind: 'bookmarks' },
      ],
    })
    const result = await callJson('add_bookmark', {
      section: 'links',
      group: 'Router',
      label: 'AdGuard',
      host: '192.168.2.1',
      port: 8080,
      path: '/login.html',
      icon: 'adguard-home',
    })
    expect(result.isError).toBe(false)

    const sections = await callJson('get_sections')
    if (!sections.isError) {
      const links = (
        sections.value.sections as {
          kind: string
          groups?: { title: string; links: unknown[] }[]
        }[]
      ).find((s) => s.kind === 'bookmarks')
      expect(links?.groups?.[0]).toMatchObject({ title: 'Router' })
      expect(links?.groups?.[0]?.links).toHaveLength(1)
    }
    const { resolved } = (await context.state()) as { resolved: Resolved }
    const section = resolved.pages[0]?.sections.find((s) => s.kind === 'bookmarks')
    expect(section?.kind === 'bookmarks' && section.groups[0]?.links[0]?.href).toBe(
      'http://192.168.2.1:8080/login.html',
    )
  })
})
