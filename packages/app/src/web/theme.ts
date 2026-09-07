import type { Theme } from '../server/config/schema.ts'
import { resolveTokens, THEME_TOKENS } from '../shared/theme-tokens.ts'

/**
 * Apply a theme in the browser.
 *
 * A colour picked in the editor takes effect immediately, before anything is republished, because
 * every colour the page paints is a custom property. This writes the same names the publish step
 * bakes into the stylesheet, resolved by the same function — so the preview and the published
 * page cannot disagree.
 */

export function currentScheme(theme: Theme): 'light' | 'dark' {
  if (theme.mode === 'light' || theme.mode === 'dark') return theme.mode
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme.mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme.mode)

  const tokens = resolveTokens(theme, currentScheme(theme))
  for (const token of THEME_TOKENS) {
    const value = tokens[token]
    if (value !== undefined) root.style.setProperty(`--nh-${token}`, value)
  }
}

/** Undo a runtime override so the baked stylesheet is visible again. */
export function clearThemeOverrides(root: HTMLElement = document.documentElement): void {
  for (const token of THEME_TOKENS) root.style.removeProperty(`--nh-${token}`)
}
