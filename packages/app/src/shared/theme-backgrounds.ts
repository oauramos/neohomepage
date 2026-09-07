/**
 * Generated backgrounds, as CSS rather than as a renderer.
 *
 * The obvious way to offer "a nice background without uploading a photo" is a WebGL shader
 * gradient. It is the wrong trade here twice over: the board is served as static HTML that has to
 * render with JavaScript disabled — a canvas paints nothing under `curl` or under the no-JS
 * Playwright profile — and three.js is around 600 KB of script for a page whose whole claim is
 * 46 MB resident with no bundler on the box.
 *
 * Layered `radial-gradient`s reach the same place: they are painted by the compositor, cost no
 * bytes of JavaScript, survive with scripting off, and — because each one is written in terms of
 * `--nh-accent`, `--nh-ok` and `--nh-bad` via `color-mix` — they recolour themselves when the
 * preset changes instead of needing one variant per theme.
 *
 * Referenced from `theme.surface.background` as `gradient:<id>`. Anything without that prefix is
 * still treated as an asset URL, so an uploaded image keeps working unchanged.
 */

export const GRADIENT_PREFIX = 'gradient:'

export type Background = {
  readonly id: string
  readonly label: string
  /** The `background` shorthand painted onto the fixed layer behind the page. */
  readonly css: string
}

/**
 * `background-color` is listed last in each value so the gradients composite over the theme's own
 * page colour: that is what keeps a light preset's version of a gradient light.
 */
export const BACKGROUNDS: readonly Background[] = [
  {
    id: 'mesh',
    label: 'Mesh',
    css:
      'radial-gradient(60% 60% at 12% 8%,color-mix(in oklch,var(--nh-accent) 34%,transparent),transparent 70%),' +
      'radial-gradient(50% 55% at 88% 14%,color-mix(in oklch,var(--nh-ok) 26%,transparent),transparent 70%),' +
      'radial-gradient(65% 60% at 72% 92%,color-mix(in oklch,var(--nh-bad) 22%,transparent),transparent 70%),' +
      'var(--nh-background)',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    css:
      'radial-gradient(120% 70% at 50% -20%,color-mix(in oklch,var(--nh-accent) 40%,transparent),transparent 65%),' +
      'radial-gradient(90% 55% at 15% 0%,color-mix(in oklch,var(--nh-ok) 24%,transparent),transparent 70%),' +
      'radial-gradient(90% 55% at 85% 5%,color-mix(in oklch,var(--nh-warn) 20%,transparent),transparent 70%),' +
      'var(--nh-background)',
  },
  {
    id: 'dusk',
    label: 'Dusk',
    css:
      'linear-gradient(180deg,color-mix(in oklch,var(--nh-accent) 26%,transparent) 0%,transparent 45%),' +
      'linear-gradient(0deg,color-mix(in oklch,var(--nh-bad) 18%,transparent) 0%,transparent 40%),' +
      'var(--nh-background)',
  },
  {
    id: 'glow',
    label: 'Spotlight',
    css:
      'radial-gradient(80% 50% at 50% 0%,color-mix(in oklch,var(--nh-accent) 28%,transparent),transparent 70%),' +
      'var(--nh-background)',
  },
  {
    id: 'grid',
    label: 'Blueprint',
    css:
      'repeating-linear-gradient(0deg,color-mix(in oklch,var(--nh-border) 55%,transparent) 0 1px,transparent 1px 48px),' +
      'repeating-linear-gradient(90deg,color-mix(in oklch,var(--nh-border) 55%,transparent) 0 1px,transparent 1px 48px),' +
      'var(--nh-background)',
  },
  {
    id: 'dots',
    label: 'Dot matrix',
    css:
      'radial-gradient(circle at 1px 1px,color-mix(in oklch,var(--nh-muted-foreground) 45%,transparent) 1px,transparent 0) 0 0/22px 22px,' +
      'var(--nh-background)',
  },
  {
    id: 'scanlines',
    label: 'Scanlines',
    css:
      'repeating-linear-gradient(0deg,color-mix(in oklch,var(--nh-accent) 12%,transparent) 0 1px,transparent 1px 4px),' +
      'radial-gradient(100% 70% at 50% 50%,color-mix(in oklch,var(--nh-accent) 14%,transparent),transparent 75%),' +
      'var(--nh-background)',
  },
  {
    id: 'vignette',
    label: 'Vignette',
    css:
      'radial-gradient(120% 90% at 50% 45%,transparent 40%,color-mix(in oklch,var(--nh-foreground) 22%,transparent) 100%),' +
      'var(--nh-background)',
  },
]

export function backgroundById(id: string): Background | undefined {
  return BACKGROUNDS.find((background) => background.id === id)
}

/**
 * Resolve `theme.surface.background` to a generated gradient, or to nothing.
 *
 * Returns undefined for an asset path so the caller keeps its existing `url()` branch — including
 * the escaping that branch does, which a gradient does not need because none of this is
 * caller-supplied text.
 */
export function gradientFor(background: string | null): Background | undefined {
  if (background === null || !background.startsWith(GRADIENT_PREFIX)) return undefined
  return backgroundById(background.slice(GRADIENT_PREFIX.length))
}

/**
 * An uploaded background is an asset path the app itself stored, but it still gets escaped: a
 * quote or a parenthesis would end the `url()` early and let the rest be read as CSS.
 */
function cssUrl(value: string): string {
  return value.replace(/["'()\\\n\r]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)
}

export type Surface = {
  readonly background: string | null
  readonly blur: number
  readonly overlayOpacity: number
}

/**
 * The two fixed layers behind the page, as CSS.
 *
 * Shared rather than server-only because the background is the one part of a theme that is NOT a
 * custom property: it is a rule on `body::before`. The publish step bakes this into the generation
 * and the design panel injects the identical string into a `<style>` so a background previews
 * immediately — without which picking one did nothing visible until the next publish and reload,
 * which reads as a broken control rather than a deferred one.
 *
 * Returns an empty string when no background is set, so the caller can clear its style element by
 * assigning the result unconditionally.
 */
export function surfaceLayerCss(surface: Surface): string {
  if (surface.background === null) return ''
  const gradient = gradientFor(surface.background)
  const layer =
    gradient === undefined
      ? `background-image:url("${cssUrl(surface.background)}");background-size:cover;` +
        `background-position:center;`
      : `background:${gradient.css};`
  return (
    `body::before{content:"";position:fixed;inset:0;z-index:-1;${layer}` +
    `filter:blur(${String(surface.blur)}px);}\n` +
    `body::after{content:"";position:fixed;inset:0;z-index:-1;` +
    `background:var(--nh-background);opacity:${String(surface.overlayOpacity)};}`
  )
}
