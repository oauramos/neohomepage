import type { Theme } from '../config/schema.ts'
import { surfaceLayerCss } from '../../shared/theme-backgrounds.ts'
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

  const surface = surfaceLayerCss(theme.surface)
  if (surface !== '') parts.push(surface)
  return parts.join('\n')
}

/**
 * The stylesheet that makes a published page readable with no JavaScript and no bundle. Tailwind
 * builds the editor; this is what a `curl` of the dashboard renders as.
 */
export const BASE_STYLESHEET = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--nh-background);color:var(--nh-foreground);
  font-family:var(--nh-font-sans);-webkit-font-smoothing:antialiased}
/* Unbounded, a four-column tile on an ultrawide becomes a metre of button. The cap is a token so
   a preset — or the design panel — can widen it back to none. */
.nh-header,main{max-width:var(--nh-max-width);margin-inline:auto}
.nh-header{padding:24px 16px 8px}
.nh-title{margin:0;font-size:1.25rem;font-weight:600;letter-spacing:-0.01em}
/* A theme change is a custom property on :root, which invalidates style for the whole document —
   and a board is thirty-odd tiles. Measured while dragging the radius slider: 13ms median and 63ms
   at the 95th percentile with 32 tiles, against 1.8ms and 3.3ms with four. The work is per-tile
   paint, so the fix is per-tile too. Containment promises a tile's layout and paint stay inside
   it; content-visibility lets the browser skip the ones scrolled out of view entirely. The board is
   absolutely positioned from the emitted grid CSS, so every tile already has its height and
   skipping one cannot move anything. */
.nh-tile{background:var(--nh-surface);color:var(--nh-surface-foreground);
  border:var(--nh-border-width) solid var(--nh-border);border-radius:var(--nh-radius);
  box-shadow:var(--nh-shadow);padding:12px 14px;overflow:hidden;
  contain:layout paint;content-visibility:auto;
  display:flex;flex-direction:column;gap:8px}
/* State is carried on the tile and was, until now, painted by nothing: a dead service and a
   healthy one were the same rectangle apart from an 11px chip. A left rule reads across a room. */
.nh-tile[data-neo-state="error"]{border-color:color-mix(in oklch,var(--nh-bad) 55%,var(--nh-border));
  box-shadow:var(--nh-shadow),inset 3px 0 0 0 var(--nh-bad)}
.nh-tile[data-neo-state="stale"]{box-shadow:var(--nh-shadow),inset 3px 0 0 0 var(--nh-warn)}
.nh-tile[data-neo-state="pending"] .nh-tile-body{opacity:0.7}
.nh-tile-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nh-tile-title{margin:0;font-size:var(--nh-title-size);font-weight:600;
  letter-spacing:var(--nh-title-tracking);text-transform:var(--nh-title-transform);
  color:var(--nh-muted-foreground)}
.nh-tile-body{flex:1;min-height:0;overflow:hidden}
/* min() so a pill stays a pill on rounded themes and squares off on the zero-radius ones. */
.nh-chip{font-size:0.6875rem;padding:2px 6px;border-radius:min(999px,max(var(--nh-radius),2px));
  background:var(--nh-muted);color:var(--nh-muted-foreground)}
/* The tone rides the RING, not the fill. A tinted fill put the bad colour on an 18% wash of
   itself, which measured 3.82:1 and had never been seen by axe because the accessibility board
   carried no widgets - while bad-on-muted is the exact pair theme-contrast.test.ts proves for
   every preset. Keeping the fill at muted is what makes that proof cover this chip. */
.nh-chip[data-neo-chip="error"]{background:var(--nh-muted);color:var(--nh-bad);
  box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--nh-bad) 50%,transparent)}
.nh-chip[data-neo-chip="stale"]{background:var(--nh-muted);color:var(--nh-warn);
  box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--nh-warn) 50%,transparent)}
.nh-placeholder{margin:0;color:var(--nh-muted-foreground);font-size:0.8125rem}
/* A link tile IS a bookmark: the whole body is the target, not the few characters of its label.
   Unstyled, this anchor measured 83x18 — under WCAG 2.5.8's 24x24 and a poor thing to aim a thumb
   at, on the one widget whose entire job is being tapped. */
.nh-link{display:flex;align-items:center;justify-content:center;min-height:44px;height:100%;
  padding:8px 12px;border-radius:var(--nh-radius-control);text-decoration:none;
  color:var(--nh-link-color);font-weight:var(--nh-link-weight);background:var(--nh-link-bg);
  border:var(--nh-link-border);box-shadow:var(--nh-link-shadow);
  transition:background 180ms ease,box-shadow 180ms ease,transform 180ms ease}
.nh-link:hover{background:var(--nh-link-bg-hover)}
.nh-link:active{transform:translateY(1px)}
.nh-link:focus-visible{outline:2px solid var(--nh-accent);outline-offset:2px}
.nh-stats{margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px}
.nh-stat dt{font-size:0.6875rem;color:var(--nh-muted-foreground)}
.nh-stat dd{margin:0;font-size:1.125rem;font-weight:600;font-variant-numeric:tabular-nums}
/* The projection has been emitting a tone on every stat since v1 with no selector to receive it. */
.nh-stat dd[data-neo-tone="ok"]{color:var(--nh-ok)}
.nh-stat dd[data-neo-tone="warn"]{color:var(--nh-warn)}
.nh-stat dd[data-neo-tone="bad"]{color:var(--nh-bad)}
.nh-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.nh-item{display:flex;align-items:baseline;gap:6px;font-size:0.8125rem}
.nh-item-title{font-weight:500}
.nh-item-subtitle{color:var(--nh-muted-foreground);font-size:0.75rem}
.nh-item-badge{margin-left:auto;color:var(--nh-muted-foreground);font-variant-numeric:tabular-nums}
/* gauge-set and status-badge shipped with no rules at all: an empty span with no width is
   invisible, so two of the five templates drew literally nothing. */
.nh-gauges{display:flex;flex-direction:column;gap:10px}
.nh-gauge{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center}
.nh-gauge-label{font-size:0.6875rem;color:var(--nh-muted-foreground);grid-column:1}
.nh-gauge-track{grid-column:1/-1;display:block;height:8px;width:100%;overflow:hidden;
  border-radius:min(999px,max(var(--nh-radius),2px));background:var(--nh-muted)}
.nh-gauge-fill{display:block;height:100%;background:var(--nh-accent);
  border-radius:inherit;transition:width 320ms ease}
.nh-gauge-fill[data-neo-tone="ok"]{background:var(--nh-ok)}
.nh-gauge-fill[data-neo-tone="warn"]{background:var(--nh-warn)}
.nh-gauge-fill[data-neo-tone="bad"]{background:var(--nh-bad)}
.nh-status{display:flex;align-items:center;gap:8px;font-size:0.875rem}
.nh-status-dot{width:10px;height:10px;border-radius:999px;flex:none;
  background:var(--nh-muted-foreground)}
.nh-status-label{text-transform:capitalize}
.nh-status[data-neo-status="ok"] .nh-status-dot{background:var(--nh-ok);
  box-shadow:0 0 0 4px color-mix(in oklch,var(--nh-ok) 22%,transparent)}
.nh-status[data-neo-status="degraded"] .nh-status-dot{background:var(--nh-warn);
  box-shadow:0 0 0 4px color-mix(in oklch,var(--nh-warn) 22%,transparent)}
.nh-status[data-neo-status="down"] .nh-status-dot{background:var(--nh-bad);
  box-shadow:0 0 0 4px color-mix(in oklch,var(--nh-bad) 22%,transparent)}
.nh-status[data-neo-status="ok"] .nh-status-label{color:var(--nh-ok)}
.nh-status[data-neo-status="degraded"] .nh-status-label{color:var(--nh-warn)}
.nh-status[data-neo-status="down"] .nh-status-label{color:var(--nh-bad)}
/* A first boot has no widgets, and rendered as an empty div: a heading over 32px of nothing. */
.nh-board-empty{margin:16px;padding:28px 24px;border:var(--nh-border-width) dashed var(--nh-border);
  border-radius:var(--nh-radius);color:var(--nh-muted-foreground);text-align:center}
.nh-board-empty strong{display:block;color:var(--nh-foreground);font-size:1rem;margin-bottom:4px}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{transition-duration:0.01ms !important;animation-duration:0.01ms !important}
}
`.trim()
