import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { dashboard } from '../../shared/board.ts'
import { emitGridCss, type Breakpoint, type GridConfig } from '../../shared/grid-css.ts'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import type { Resolved } from '../../shared/resolved.ts'
import { writeFileDurable } from '../store/atomic.ts'
import { Generations } from '../store/generations.ts'
import { BASE_STYLESHEET, themeVariables } from './theme.ts'

/**
 * Publishing: turn the resolved config into a static page.
 *
 * This is the decisive difference from building on a framework. Regeneration is a
 * `renderToStaticMarkup` call — a function, costing single-digit megabytes of transient heap —
 * not a bundler run, which on a 1 GB box is a machine-freezing event. Everything expensive
 * (bundling, type checking, Tailwind) happened in CI and never happens here.
 *
 * The generation directory is written in full, smoke-checked, and only then does the pointer move.
 * A failed render leaves the previous generation serving.
 */

export class PublishError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PublishError'
  }
}

export type PublishInput = {
  readonly resolved: Resolved
  readonly stateDir: string
  readonly configDir: string
  readonly configRevision: string
  readonly actor: string
  /** Directory holding the built SPA, for the asset tags. Absent in a source checkout. */
  readonly webDistDir?: string
  readonly label?: string
}

export type PublishResult = {
  readonly generation: number
  readonly html: string
  readonly bytes: number
  readonly durationMs: number
}

/** A sentinel the smoke check looks for. If this is missing, the render produced nothing usable. */
const ROOT_SENTINEL = 'id="neo-root"'

function gridConfigFor(page: Resolved['pages'][number]): GridConfig {
  return {
    breakpoints: page.grid.breakpoints as readonly Breakpoint[],
    rowHeight: page.grid.rowHeight,
    margin: page.grid.margin,
    containerPadding: page.grid.containerPadding,
  }
}

/**
 * Read Vite's manifest to find the built asset filenames.
 *
 * Absent in a source checkout, which is fine: the published page is complete HTML and CSS on its
 * own. The bundle only adds live updates and the editor.
 */
async function assetTags(webDistDir: string | undefined): Promise<string> {
  if (webDistDir === undefined) return ''
  try {
    const manifestPath = join(webDistDir, '.vite', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      { file?: string; css?: string[] }
    >
    const entry = Object.values(manifest).find((value) => typeof value.file === 'string')
    if (entry === undefined) return ''
    const css = (entry.css ?? []).map((href) => `<link rel="stylesheet" href="/_app/${href}">`)
    return [...css, `<script type="module" src="/_app/${entry.file as string}"></script>`].join(
      '\n    ',
    )
  } catch {
    return ''
  }
}

export function renderDocument(options: {
  readonly resolved: Resolved
  readonly assets: string
}): string {
  const { resolved } = options

  const gridCss = resolved.pages
    .map((page) => {
      const layouts = page.layouts as Readonly<Record<string, readonly LayoutItem[]>>
      return emitGridCss(gridConfigFor(page), layouts, `.neo-board[data-neo-page="${page.id}"]`)
    })
    .join('\n')

  const body = renderToStaticMarkup(dashboard(resolved, {}))

  // Only non-secret resolved state is embedded. `curl` against the page therefore reveals the
  // layout and the widget names, and nothing about credentials or upstream responses.
  const state = JSON.stringify({
    title: resolved.title,
    defaultPage: resolved.defaultPage,
    generatedAt: resolved.generatedAt,
    pages: resolved.pages,
    widgets: resolved.widgets,
    theme: resolved.theme,
  })

  return `<!doctype html>
<html lang="en" ${resolved.theme.mode === 'system' ? '' : `data-theme="${resolved.theme.mode}"`}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(resolved.title)}</title>
    <style>${BASE_STYLESHEET}
${themeVariables(resolved.theme)}
${gridCss}</style>
    ${options.assets}
  </head>
  <body>
    <div id="neo-root">${body}</div>
    <script id="__NEO_STATE__" type="application/json">${escapeJsonForScript(state)}</script>
  </body>
</html>
`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * `</script>` inside embedded JSON ends the script element early, whatever the JSON says. A
 * dashboard title or a widget name is user-controlled, so this is a real escape, not a formality.
 */
function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const startedAt = performance.now()
  const assets = await assetTags(input.webDistDir)

  let html: string
  try {
    html = renderDocument({ resolved: input.resolved, assets })
  } catch (error) {
    throw new PublishError('rendering the dashboard failed; the previous generation still serves', {
      cause: error,
    })
  }

  // Smoke check before anything is committed. A render that "succeeded" but produced an empty or
  // structurally broken document must not become the page people see.
  if (!html.includes(ROOT_SENTINEL) || html.length < 200) {
    throw new PublishError('the rendered document failed its smoke check; nothing was published')
  }

  const generations = new Generations(input.stateDir)
  const meta = await generations.cut({
    configDir: input.configDir,
    configRevision: input.configRevision,
    actor: input.actor,
    ...(input.label === undefined ? {} : { label: input.label }),
  })

  const directory = generations.path(meta.generation)
  await writeFileDurable(join(directory, 'index.html'), html)
  await writeFileDurable(
    join(directory, 'resolved.json'),
    `${JSON.stringify(input.resolved, null, 2)}\n`,
  )

  return {
    generation: meta.generation,
    html,
    bytes: Buffer.byteLength(html, 'utf8'),
    durationMs: Math.round(performance.now() - startedAt),
  }
}

/** Content hash of a config tree, for the "N pending changes" badge. */
export function configHash(revision: string): string {
  return createHash('sha256').update(revision).digest('hex').slice(0, 16)
}
