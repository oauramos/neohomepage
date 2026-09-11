/**
 * Generated backgrounds as layered CSS gradients over theme tokens: they render with JavaScript
 * off and recolour per preset. Referenced from `theme.surface.background` as `gradient:<id>`;
 * anything else is an asset URL.
 */

export const GRADIENT_PREFIX = 'gradient:'

export type Background = {
  readonly id: string
  readonly label: string
  /** The `background` shorthand painted onto the fixed layer behind the page. */
  readonly css: string
}

/** `background-color` is last in each value so gradients composite over the theme's page colour. */
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
  // The four era backgrounds: still token-based, but shaped for the console presets, which ask for
  // them by name.
  {
    id: 'dmg-matrix',
    label: 'DMG matrix',
    // Reflective LCD: square cells with a visible gap, no blur.
    css:
      'repeating-linear-gradient(0deg,color-mix(in oklch,var(--nh-foreground) 9%,transparent) 0 1px,transparent 1px 4px),' +
      'repeating-linear-gradient(90deg,color-mix(in oklch,var(--nh-foreground) 9%,transparent) 0 1px,transparent 1px 4px),' +
      'radial-gradient(120% 100% at 50% 0%,color-mix(in oklch,var(--nh-accent) 10%,transparent),transparent 70%),' +
      'var(--nh-background)',
  },
  {
    id: 'snes-weave',
    label: 'SNES weave',
    // The console's moulded plastic had a fine diagonal texture; a 16-bit sky had banded gradients.
    css:
      'repeating-linear-gradient(45deg,color-mix(in oklch,var(--nh-accent) 5%,transparent) 0 2px,transparent 2px 6px),' +
      'linear-gradient(180deg,color-mix(in oklch,var(--nh-accent) 22%,transparent) 0%,transparent 55%),' +
      'radial-gradient(80% 60% at 80% 100%,color-mix(in oklch,var(--nh-ok) 16%,transparent),transparent 70%),' +
      'var(--nh-background)',
  },
  {
    id: 'neogeo-scan',
    label: 'Arcade scan',
    // A CRT cabinet: hard scanlines, a hot centre where the tube is brightest, and a dark surround.
    css:
      'repeating-linear-gradient(0deg,color-mix(in oklch,var(--nh-foreground) 16%,transparent) 0 2px,transparent 2px 5px),' +
      'radial-gradient(90% 70% at 50% 40%,color-mix(in oklch,var(--nh-accent) 22%,transparent),transparent 75%),' +
      'radial-gradient(140% 110% at 50% 50%,transparent 45%,color-mix(in oklch,var(--nh-foreground) 30%,transparent) 100%),' +
      'var(--nh-background)',
  },
  {
    id: 'ps1-haze',
    label: '3D haze',
    // Early 3D fogged the far plane to hide the draw distance. Broad, soft, overlapping washes.
    css:
      'radial-gradient(90% 70% at 20% 10%,color-mix(in oklch,var(--nh-accent) 30%,transparent),transparent 70%),' +
      'radial-gradient(80% 70% at 85% 25%,color-mix(in oklch,var(--nh-bad) 20%,transparent),transparent 72%),' +
      'linear-gradient(180deg,transparent 40%,color-mix(in oklch,var(--nh-ok) 16%,transparent) 100%),' +
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

/** Returns undefined for an asset path so the caller keeps its escaped `url()` branch. */
export function gradientFor(background: string | null): Background | undefined {
  if (background === null || !background.startsWith(GRADIENT_PREFIX)) return undefined
  return backgroundById(background.slice(GRADIENT_PREFIX.length))
}

// Escapes what would end the `url()` early; `<`/`>` because the string is baked into an inline
// `<style>`, where `</style>` closes the sheet from inside a valid url(); form feed because CSS
// counts it as a newline.
function cssUrl(value: string): string {
  return value.replace(
    /["'()<>\\\n\r\f]/g,
    (character) => `\\${character.charCodeAt(0).toString(16)} `,
  )
}

export type Surface = {
  readonly background: string | null
  readonly blur: number
  readonly overlayOpacity: number
}

/**
 * The two fixed layers behind the page, as CSS. Shared with the web side because the background is
 * a `body::before` rule, not a custom property, and the design panel injects the same string for
 * preview. Returns '' when no background is set so the caller can assign unconditionally.
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
