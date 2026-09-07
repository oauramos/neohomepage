import type { Theme } from '../config/schema.ts'
import {
  DARK_DEFAULTS,
  LIGHT_DEFAULTS,
  resolveTokens,
  THEME_TOKENS,
  type ThemeToken,
} from '../../shared/theme-tokens.ts'

export { DARK_DEFAULTS, LIGHT_DEFAULTS, THEME_TOKENS }
export type { ThemeToken }

/**
 * Theme tokens and the base stylesheet baked into a published generation.
 *
 * Every colour is a custom property on `:root`, so the editor changing a theme is a property write
 * rather than a rebuild — and the same token set is what the SPA applies at runtime. Those are two
 * paths to one appearance, which is exactly the shape that produced the layout parity test, so
 * they get one too: `THEME_TOKENS` is the single list both sides iterate.
 */

function block(selector: string, tokens: Record<string, string>): string {
  const declarations = Object.entries(tokens)
    .map(([name, value]) => `--nh-${name}:${value}`)
    .join(';')
  return `${selector}{${declarations}}`
}

/**
 * Emit the theme as CSS.
 *
 * Light is defined on bare `:root` so it is the fallback everywhere. Dark is defined twice — once
 * under `prefers-color-scheme` guarded against an explicit light choice, and once under
 * `[data-theme="dark"]` — so an explicit choice wins in both directions and the default "system"
 * setting still follows the OS.
 */
export function themeVariables(theme: Theme): string {
  // Both emitted blocks come from resolveTokens, the same function the browser calls when the
  // editor changes a colour. That is what makes the parity test meaningful rather than decorative.
  const light = resolveTokens(theme, 'light')
  const dark = resolveTokens(theme, 'dark')

  const parts = [block(':root', light)]
  parts.push(
    `@media (prefers-color-scheme: dark){${block(':root:not([data-theme="light"])', dark)}}`,
  )
  parts.push(block(':root[data-theme="dark"]', dark))

  const surface = theme.surface
  if (surface.background !== null) {
    parts.push(
      `body::before{content:"";position:fixed;inset:0;z-index:-1;` +
        `background-image:url("${cssUrl(surface.background)}");background-size:cover;` +
        `background-position:center;filter:blur(${surface.blur}px);}`,
      `body::after{content:"";position:fixed;inset:0;z-index:-1;` +
        `background:var(--nh-background);opacity:${surface.overlayOpacity};}`,
    )
  }
  return parts.join('\n')
}

/**
 * A background is an asset path the app itself stored, but it still gets escaped: a quote or a
 * parenthesis would end the `url()` early and let the rest be read as CSS.
 */
function cssUrl(value: string): string {
  return value.replace(/["'()\\\n\r]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)
}

/**
 * The stylesheet that makes a published page readable with no JavaScript and no bundle. Tailwind
 * builds the editor; this is what a `curl` of the dashboard renders as.
 */
export const BASE_STYLESHEET = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--nh-background);color:var(--nh-foreground);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
.nh-header{padding:24px 16px 8px}
.nh-title{margin:0;font-size:1.25rem;font-weight:600;letter-spacing:-0.01em}
.nh-tile{background:var(--nh-surface);color:var(--nh-surface-foreground);
  border:1px solid var(--nh-border);border-radius:12px;padding:12px 14px;overflow:hidden;
  display:flex;flex-direction:column;gap:8px}
.nh-tile-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nh-tile-title{margin:0;font-size:0.8125rem;font-weight:600;letter-spacing:0.01em;
  text-transform:uppercase;color:var(--nh-muted-foreground)}
.nh-tile-body{flex:1;min-height:0;overflow:hidden}
.nh-chip{font-size:0.6875rem;padding:2px 6px;border-radius:999px;background:var(--nh-muted);
  color:var(--nh-muted-foreground)}
.nh-chip[data-neo-chip="error"]{background:color-mix(in oklch,var(--nh-bad) 18%,transparent);
  color:var(--nh-bad)}
.nh-placeholder{margin:0;color:var(--nh-muted-foreground);font-size:0.8125rem}
.nh-stats{margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px}
.nh-stat dt{font-size:0.6875rem;color:var(--nh-muted-foreground)}
.nh-stat dd{margin:0;font-size:1.125rem;font-weight:600;font-variant-numeric:tabular-nums}
.nh-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.nh-item{display:flex;align-items:baseline;gap:6px;font-size:0.8125rem}
.nh-item-title{font-weight:500}
.nh-item-subtitle{color:var(--nh-muted-foreground);font-size:0.75rem}
.nh-item-badge{margin-left:auto;color:var(--nh-muted-foreground);font-variant-numeric:tabular-nums}
`.trim()
