import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { themeSchema, pageSchema } from '../config/schema.ts'
import type { Resolved } from '../../shared/resolved.ts'
import { Generations } from '../store/generations.ts'
import { publish, renderDocument } from './publish.ts'
import { LIGHT_DEFAULTS, themeVariables, THEME_TOKENS } from './theme.ts'

const created: string[] = []

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

function resolved(overrides: Partial<Resolved> = {}): Resolved {
  const page = pageSchema.parse({ id: 'home' })
  return {
    schemaVersion: 1,
    title: 'neohomepage',
    defaultPage: 'home',
    generatedAt: '2026-09-06T12:00:00.000Z',
    pages: [
      {
        id: 'home',
        title: 'Home',
        grid: page.grid,
        layouts: { sm: [{ i: 'w1', x: 0, y: 0, w: 2, h: 3 }], md: [], lg: [] },
        widgetIds: ['w1'],
      },
    ],
    widgets: [
      {
        id: 'w1',
        page: 'home',
        type: 'sonarr-queue',
        title: 'Sonarr queue',
        template: 'list',
        icon: 'sonarr',
        targetId: 'tSonarr',
        config: {},
        operations: ['queue'],
        pollIntervalMs: 60_000,
        unsupported: false,
      },
    ],
    targets: [
      { id: 'tSonarr', label: 'Sonarr', origin: 'http://10.0.0.20:8989', minIntervalMs: 15_000 },
    ],
    theme: themeSchema.parse({}),
    diagnostics: [],
    ...overrides,
  }
}

describe('the published document', () => {
  it('is complete HTML with the board and its positioning stylesheet', () => {
    const html = renderDocument({ resolved: resolved(), assets: '' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('id="neo-root"')
    expect(html).toContain('data-neo-i="w1"')
    // Positioning is CSS, not a measurement pass: no grid library ships on this page.
    expect(html).toContain('--nh-col:calc(')
    expect(html).toContain('@media (min-width:768px)')
  })

  it('needs no JavaScript to be laid out', () => {
    const html = renderDocument({ resolved: resolved(), assets: '' })
    // The only script is the inert state payload; everything visual is HTML and CSS.
    const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0])
    expect(scripts).toEqual(['<script id="__NEO_STATE__" type="application/json">'])
  })

  it('embeds no credential and no upstream data', () => {
    // curl against a published page reveals the layout and the widget names, and nothing else.
    const html = renderDocument({ resolved: resolved(), assets: '' })
    expect(html).not.toContain('secret')
    expect(html).not.toContain('apiKey')
  })

  it('escapes a title that would otherwise close the tag', () => {
    const html = renderDocument({
      resolved: resolved({ title: '</title><script>alert(1)</script>' }),
      assets: '',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;/title&gt;')
  })

  it('escapes an embedded state payload that would close the script element', () => {
    // A widget title is user-controlled, and `</script>` inside JSON ends the element whatever
    // the JSON says.
    const hostile = resolved()
    const html = renderDocument({
      resolved: {
        ...hostile,
        widgets: [
          { ...(hostile.widgets[0] as (typeof hostile.widgets)[number]), title: '</script><img>' },
        ],
      },
      assets: '',
    })
    const stateBlock = html.slice(html.indexOf('__NEO_STATE__'))
    expect(stateBlock).not.toContain('</script><img>')
    expect(stateBlock).toContain('\\u003c/script\\u003e')
  })

  it('sets data-theme only for an explicit choice, so "system" follows the OS', () => {
    // Check the html tag, not the whole document: the stylesheet legitimately contains
    // `:root[data-theme="dark"]` in every case, which is the point of emitting both.
    const htmlTag = (document: string) => document.split('\n')[1] as string
    expect(htmlTag(renderDocument({ resolved: resolved(), assets: '' }))).not.toContain(
      'data-theme',
    )

    const dark = resolved({ theme: themeSchema.parse({ mode: 'dark' }) })
    expect(htmlTag(renderDocument({ resolved: dark, assets: '' }))).toContain('data-theme="dark"')
  })
})

describe('theme emission', () => {
  it('defines every token on bare :root, so light is the fallback everywhere', () => {
    const css = themeVariables(themeSchema.parse({}))
    for (const token of THEME_TOKENS) {
      expect(css).toContain(`--nh-${token}:`)
    }
    const rootBlock = css.slice(css.indexOf(':root{'), css.indexOf('}'))
    for (const token of THEME_TOKENS) expect(rootBlock).toContain(`--nh-${token}`)
  })

  it('lets an explicit choice win in both directions', () => {
    // Dark appears twice on purpose: under prefers-color-scheme guarded against an explicit
    // light choice, and under [data-theme="dark"].
    const css = themeVariables(themeSchema.parse({}))
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"])')
    expect(css).toContain(':root[data-theme="dark"]')
  })

  it('takes user overrides over the defaults', () => {
    const css = themeVariables(themeSchema.parse({ cssVars: { light: { accent: 'red' } } }))
    expect(css).toContain('--nh-accent:red')
    expect(css).not.toContain(`--nh-accent:${LIGHT_DEFAULTS.accent}`)
  })

  it('escapes a background path that would break out of url()', () => {
    const css = themeVariables(
      themeSchema.parse({ surface: { background: '/a.png");}body{display:none}/*' } }),
    )
    // The payload text survives — inside the quoted string, which is the correct outcome. What
    // matters is that neither the quote nor the paren reaches the parser unescaped, so the
    // declaration cannot be terminated early and the rest is never read as CSS.
    const declaration = css.slice(css.indexOf('background-image:url('))
    const url = declaration.slice(0, declaration.indexOf(');'))
    expect(url).toContain('\\22 ')
    expect(url).toContain('\\29 ')
    expect(url).not.toMatch(/[^\\]"\)/)
  })
})

describe('publishing', () => {
  async function scratch() {
    const root = await mkdtemp(join(tmpdir(), 'neo-publish-'))
    created.push(root)
    const configDir = join(root, 'config')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'dashboard.json'), '{"schemaVersion":1}\n')
    return { root, configDir, stateDir: join(root, 'state') }
  }

  it('writes a generation and moves the pointer', async () => {
    const { configDir, stateDir } = await scratch()
    const result = await publish({
      resolved: resolved(),
      stateDir,
      configDir,
      configRevision: 'rev1',
      actor: 'test',
    })
    expect(result.generation).toBe(1)

    const generations = new Generations(stateDir)
    expect(await generations.current()).toBe(1)
    const html = await readFile(join(generations.path(1), 'index.html'), 'utf8')
    expect(html).toContain('data-neo-i="w1"')
  })

  it('records the config revision, which is what the pending badge compares against', async () => {
    const { configDir, stateDir } = await scratch()
    await publish({
      resolved: resolved(),
      stateDir,
      configDir,
      configRevision: 'rev1',
      actor: 'test',
    })
    const meta = await new Generations(stateDir).meta(1)
    expect(meta?.configRevision).toBe('rev1')
  })

  it('keeps serving the previous generation when a render fails', async () => {
    const { configDir, stateDir } = await scratch()
    await publish({
      resolved: resolved(),
      stateDir,
      configDir,
      configRevision: 'rev1',
      actor: 'test',
    })

    // A resolved tree the renderer cannot handle: a widget id that is not CSS-selector safe, which
    // the grid emitter refuses rather than interpolating.
    const broken = resolved()
    await expect(
      publish({
        resolved: {
          ...broken,
          pages: [
            {
              ...(broken.pages[0] as (typeof broken.pages)[number]),
              layouts: { sm: [{ i: 'evil"]{}', x: 0, y: 0, w: 1, h: 1 }] },
            },
          ],
        },
        stateDir,
        configDir,
        configRevision: 'rev2',
        actor: 'test',
      }),
    ).rejects.toThrow()

    const generations = new Generations(stateDir)
    expect(await generations.current()).toBe(1)
  })
})
