import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { dashboard } from '../../shared/board.ts'
import { FAVICON_LINK } from '../../shared/favicon.ts'
import { emitPageCss } from '../../shared/section-css.ts'
import type { Resolved } from '../../shared/resolved.ts'
import { writeFileDurable } from '../store/atomic.ts'
import { Generations } from '../store/generations.ts'
import { BASE_STYLESHEET, themeVariables } from './theme.ts'

/**
 * Renders the resolved config into a static page and cuts a generation; the pointer moves only
 * after the render passes a smoke check, so a failed render leaves the previous generation serving.
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
  readonly assetsHash: string
  readonly html: string
  readonly bytes: number
  readonly durationMs: number
}

const ROOT_SENTINEL = 'id="neo-root"'

/**
 * Asset tags from Vite's manifest; empty in a source checkout, where the published page is
 * complete without the bundle.
 */
export async function currentAssetTags(webDistDir: string | undefined): Promise<string> {
  if (webDistDir === undefined) return ''
  try {
    const manifestPath = join(webDistDir, '.vite', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      { file?: string; css?: string[]; isEntry?: boolean }
    >
    // Once anything is code-split the first manifest entry is a chunk, not the entry.
    const entry = Object.values(manifest).find((value) => value.isEntry === true)
    if (entry?.file === undefined) return ''
    const css = (entry.css ?? []).map((href) => `<link rel="stylesheet" href="/_app/${href}">`)
    return [...css, `<script type="module" src="/_app/${entry.file}"></script>`].join('\n    ')
  } catch {
    return ''
  }
}

export function renderDocument(options: {
  readonly resolved: Resolved
  readonly assets: string
}): string {
  const { resolved } = options

  const gridCss = resolved.pages.map((page) => emitPageCss(page)).join('\n')

  const body = renderToStaticMarkup(dashboard(resolved, {}))

  // Targets stay out: a target names a host and its credentials, and the page is served to
  // anyone the API is not. The editor fetches them when it takes over.
  const embedded: Resolved = {
    schemaVersion: resolved.schemaVersion,
    title: resolved.title,
    defaultPage: resolved.defaultPage,
    generatedAt: resolved.generatedAt,
    pages: resolved.pages,
    widgets: resolved.widgets,
    targets: [],
    theme: resolved.theme,
    features: resolved.features,
    diagnostics: [],
  }
  const state = JSON.stringify({ resolved: embedded })

  return `<!doctype html>
<html lang="en" ${resolved.theme.mode === 'system' ? '' : `data-theme="${resolved.theme.mode}"`}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    ${FAVICON_LINK}
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

/** `</script>` inside embedded JSON ends the script element early; titles are user-controlled. */
function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const startedAt = performance.now()
  const assets = await currentAssetTags(input.webDistDir)

  let html: string
  try {
    html = renderDocument({ resolved: input.resolved, assets })
  } catch (error) {
    throw new PublishError('rendering the dashboard failed; the previous generation still serves', {
      cause: error,
    })
  }

  if (!html.includes(ROOT_SENTINEL) || html.length < 200) {
    throw new PublishError('the rendered document failed its smoke check; nothing was published')
  }

  const generations = new Generations(input.stateDir)
  const meta = await generations.cut({
    configDir: input.configDir,
    configRevision: input.configRevision,
    actor: input.actor,
    assetsHash: assetsFingerprint(assets),
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
    assetsHash: meta.assetsHash,
    html,
    bytes: Buffer.byteLength(html, 'utf8'),
    durationMs: Math.round(performance.now() - startedAt),
  }
}

/**
 * Compared on boot against the current build: an app upgrade renames the bundle without touching
 * config.
 */
export function assetsFingerprint(assets: string): string {
  return createHash('sha256').update(assets).digest('hex').slice(0, 16)
}
