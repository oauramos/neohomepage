import type { Theme } from '../server/config/schema.ts'
import { surfaceLayerCss } from '../shared/theme-backgrounds.ts'
import { ALL_TOKENS, resolveTokens } from '../shared/theme-tokens.ts'

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

const SURFACE_STYLE_ID = 'nh-surface-preview'

/**
 * The background is the one part of a theme that is a rule, not a custom property.
 *
 * `body::before` cannot be set with `style.setProperty`, so without this a background picked in the
 * design panel stayed invisible until the next publish AND a reload — indistinguishable, from the
 * user's side, from a control that does nothing. The CSS comes from `surfaceLayerCss`, the same
 * function the publish step bakes, so the preview and the published page cannot disagree.
 */
function applySurface(surface: Theme['surface']): void {
  const css = surfaceLayerCss(surface)
  let style = document.getElementById(SURFACE_STYLE_ID)
  if (css === '') {
    style?.remove()
    return
  }
  if (style === null) {
    style = document.createElement('style')
    style.id = SURFACE_STYLE_ID
    document.head.append(style)
  }
  style.textContent = css
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme.mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme.mode)

  const tokens = resolveTokens(theme, currentScheme(theme))
  for (const token of ALL_TOKENS) {
    const value = tokens[token]
    if (value !== undefined) root.style.setProperty(`--nh-${token}`, value)
  }
  applySurface(theme.surface)
}

/** Undo a runtime override so the baked stylesheet is visible again. */
export function clearThemeOverrides(root: HTMLElement = document.documentElement): void {
  for (const token of ALL_TOKENS) root.style.removeProperty(`--nh-${token}`)
}
