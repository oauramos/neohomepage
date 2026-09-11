import type { Theme } from '../server/config/schema.ts'
import { surfaceLayerCss } from '../shared/theme-backgrounds.ts'
import { ALL_TOKENS, resolveTokens } from '../shared/theme-tokens.ts'

/**
 * Applies a theme in the browser by writing the same custom properties the publish step bakes,
 * resolved by the same function, so the live preview and the published page agree.
 */

export function currentScheme(theme: Theme): 'light' | 'dark' {
  if (theme.mode === 'light' || theme.mode === 'dark') return theme.mode
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
}

const SURFACE_STYLE_ID = 'nh-surface-preview'

// The background is a `body::before` rule, not a custom property, so it cannot be set with
// `style.setProperty` and goes into an injected stylesheet instead.
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
  // Assigning identical text still invalidates the sheet.
  if (style.textContent !== css) style.textContent = css
}

// Last written tokens per root, so a repaint writes only what changed: each `:root` custom property
// write invalidates style for the whole document, and rewriting all of them per slider frame stutters.
const applied = new WeakMap<HTMLElement, Record<string, string>>()

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme.mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme.mode)

  const tokens = resolveTokens(theme, currentScheme(theme))
  const previous = applied.get(root) ?? {}
  const next: Record<string, string> = {}

  for (const token of ALL_TOKENS) {
    const value = tokens[token]
    if (value === undefined) continue
    next[token] = value
    if (previous[token] !== value) root.style.setProperty(`--nh-${token}`, value)
  }
  // Drop tokens no longer set, or a cleared override keeps painting its old value.
  for (const token of Object.keys(previous)) {
    if (next[token] === undefined) root.style.removeProperty(`--nh-${token}`)
  }

  applied.set(root, next)
  applySurface(theme.surface)
}
