import type { Theme } from '../server/config/schema.ts'

/**
 * The theme token contract, shared by the two paths that apply it.
 *
 * A published generation bakes these into a stylesheet; the editor writes the same names onto
 * `:root` so a colour change is visible before anything is republished. Two paths to one
 * appearance is the shape that produced the layout parity test, so it gets one too — and both
 * sides iterate THIS list, which is what makes the test able to fail by name when a token is
 * added on one side only.
 */

export const THEME_TOKENS = [
  'background',
  'foreground',
  'surface',
  'surface-foreground',
  'muted',
  'muted-foreground',
  'border',
  /**
   * The boundary of an interactive control, distinct from a card's edge.
   *
   * WCAG 1.4.11 wants 3:1 for the visual information that identifies a component. A card's border
   * is decorative — the surface colour already separates it — but our inputs have a transparent
   * fill, so their border is the ONLY thing that says "this is a field". At 1.25:1 it was not
   * saying it, and axe cannot catch this: it does not evaluate 1.4.11 automatically.
   */
  'control-border',
  'accent',
  'accent-foreground',
  'ok',
  'warn',
  'bad',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

export const LIGHT_DEFAULTS: Record<ThemeToken, string> = {
  background: 'oklch(0.985 0 0)',
  foreground: 'oklch(0.21 0.006 285)',
  surface: 'oklch(1 0 0)',
  'surface-foreground': 'oklch(0.21 0.006 285)',
  muted: 'oklch(0.96 0.002 286)',
  'muted-foreground': 'oklch(0.53 0.012 286)',
  border: 'oklch(0.91 0.004 286)',
  'control-border': 'oklch(0.635 0.008 286)',
  /**
   * The status colours are darker than they look like they should be, on purpose.
   *
   * OKLCH is the space where "same lightness" looks like the same lightness; WCAG contrast is
   * defined on sRGB relative luminance, which is a different quantity. A palette that looks evenly
   * weighted in OKLCH can still fail AA badly — the first version of these failed at 3.1:1 (ok),
   * 2.3:1 (warn) and 4.4:1 (accent on a muted background) while looking perfectly balanced.
   *
   * All four are solved against `muted`, the lightest surface any of them sits on, so they pass on
   * every background rather than only on the one axe happened to render. `warn` lands on a deep
   * amber for the same reason every accessible design system's warning text does.
   */
  accent: 'oklch(0.54 0.19 258)',
  'accent-foreground': 'oklch(0.99 0 0)',
  ok: 'oklch(0.52 0.136 149)',
  warn: 'oklch(0.54 0.115 71)',
  bad: 'oklch(0.56 0.22 27)',
}

export const DARK_DEFAULTS: Record<ThemeToken, string> = {
  background: 'oklch(0.16 0.004 285)',
  foreground: 'oklch(0.96 0.001 286)',
  surface: 'oklch(0.21 0.006 285)',
  'surface-foreground': 'oklch(0.96 0.001 286)',
  muted: 'oklch(0.27 0.006 286)',
  'muted-foreground': 'oklch(0.71 0.013 286)',
  border: 'oklch(0.31 0.007 286)',
  'control-border': 'oklch(0.55 0.008 286)',
  accent: 'oklch(0.7 0.15 254)',
  'accent-foreground': 'oklch(0.16 0.004 285)',
  ok: 'oklch(0.72 0.15 149)',
  warn: 'oklch(0.79 0.16 71)',
  bad: 'oklch(0.7 0.19 22)',
}

/**
 * The token values a theme resolves to, for one scheme.
 *
 * This is the single source both the stylesheet emitter and the runtime applier call, so they
 * cannot disagree about precedence: defaults, then the scheme's overrides, then the shared block.
 */
export function resolveTokens(theme: Theme, scheme: 'light' | 'dark'): Record<string, string> {
  const base = scheme === 'dark' ? DARK_DEFAULTS : LIGHT_DEFAULTS
  return { ...base, ...theme.cssVars[scheme], ...theme.cssVars.theme }
}
