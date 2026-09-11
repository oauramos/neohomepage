import type { Theme } from '../server/config/schema.ts'
import { presetById, SHAPE_DEFAULTS, SHAPE_TOKENS } from './theme-presets.ts'

/**
 * Theme token contract. The stylesheet emitter and the editor's runtime applier both iterate this
 * list; the parity test fails by name when a token is added on one side only.
 */

export const THEME_TOKENS = [
  'background',
  'foreground',
  'surface',
  'surface-foreground',
  'muted',
  'muted-foreground',
  'border',
  // Inputs have a transparent fill, so their border alone identifies them and must meet the
  // WCAG 1.4.11 3:1 ratio; `border` is decorative. axe does not check 1.4.11.
  'control-border',
  'accent',
  'accent-foreground',
  'ok',
  'warn',
  'bad',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

/**
 * Every custom property a theme emits, colour plus shape; the parity test asserts the emitted set
 * is exactly this.
 */
export const ALL_TOKENS = [...THEME_TOKENS, ...SHAPE_TOKENS] as const

export const LIGHT_DEFAULTS: Record<ThemeToken, string> = {
  background: 'oklch(0.985 0 0)',
  foreground: 'oklch(0.21 0.006 285)',
  surface: 'oklch(1 0 0)',
  'surface-foreground': 'oklch(0.21 0.006 285)',
  muted: 'oklch(0.96 0.002 286)',
  'muted-foreground': 'oklch(0.53 0.012 286)',
  border: 'oklch(0.91 0.004 286)',
  'control-border': 'oklch(0.635 0.008 286)',
  // Deliberately darker than OKLCH lightness suggests, since WCAG contrast is sRGB luminance. All
  // four are solved to AA against `muted`, the lightest surface they sit on.
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
 * Resolved token values for one scheme, in precedence order: shape defaults, colour defaults,
 * preset, scheme overrides, shared block. The preset is a merge layer below `cssVars` so clearing
 * an override falls back to the preset rather than to the stock defaults.
 */
export function resolveTokens(theme: Theme, scheme: 'light' | 'dark'): Record<string, string> {
  const base = scheme === 'dark' ? DARK_DEFAULTS : LIGHT_DEFAULTS
  const preset = presetById(theme.preset)
  return {
    ...SHAPE_DEFAULTS,
    ...base,
    ...preset?.shape,
    ...preset?.[scheme],
    ...theme.cssVars[scheme],
    ...theme.cssVars.theme,
  }
}
