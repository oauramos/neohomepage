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
  accent: 'oklch(0.55 0.19 258)',
  'accent-foreground': 'oklch(0.99 0 0)',
  ok: 'oklch(0.63 0.16 149)',
  warn: 'oklch(0.72 0.17 71)',
  bad: 'oklch(0.58 0.22 27)',
}

export const DARK_DEFAULTS: Record<ThemeToken, string> = {
  background: 'oklch(0.16 0.004 285)',
  foreground: 'oklch(0.96 0.001 286)',
  surface: 'oklch(0.21 0.006 285)',
  'surface-foreground': 'oklch(0.96 0.001 286)',
  muted: 'oklch(0.27 0.006 286)',
  'muted-foreground': 'oklch(0.71 0.013 286)',
  border: 'oklch(0.31 0.007 286)',
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
