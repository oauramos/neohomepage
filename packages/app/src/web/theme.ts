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
  // Assigning identical text still invalidates the sheet, and the blur slider would do it sixty
  // times a second while the gradient underneath never changed.
  if (style.textContent !== css) style.textContent = css
}

/**
 * What was last written, so a repaint can write only what moved.
 *
 * A custom property on `:root` invalidates style for the whole document, and the board is
 * thirty-odd tiles. Rewriting all 29 tokens on every frame of a slider drag measured a 49ms 95th
 * percentile and a 76ms worst frame — visible stutter — for a change that touched ONE of them.
 * Keyed by the element so a second root (a test, a preview) cannot inherit another's history.
 */
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
  // A token that was set and is now gone has to be removed, or a cleared override would keep
  // painting the value it was cleared from.
  for (const token of Object.keys(previous)) {
    if (next[token] === undefined) root.style.removeProperty(`--nh-${token}`)
  }

  applied.set(root, next)
  applySurface(theme.surface)
}

/** Undo a runtime override so the baked stylesheet is visible again. */
export function clearThemeOverrides(root: HTMLElement = document.documentElement): void {
  for (const token of ALL_TOKENS) root.style.removeProperty(`--nh-${token}`)
  // Forget what was written too: otherwise the next applyTheme diffs against values that are no
  // longer on the element and skips writing them back.
  applied.delete(root)
}
