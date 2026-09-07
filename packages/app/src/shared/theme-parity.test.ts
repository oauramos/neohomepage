import { describe, expect, it } from 'vitest'
import { themeSchema } from '../server/config/schema.ts'
import { themeVariables } from '../server/render/theme.ts'
import {
  ALL_TOKENS,
  DARK_DEFAULTS,
  LIGHT_DEFAULTS,
  resolveTokens,
  THEME_TOKENS,
} from './theme-tokens.ts'

/**
 * Theme parity.
 *
 * A theme is applied twice: baked into the published stylesheet, and written onto `:root` by the
 * editor so a colour change is visible before anything is republished. That is the same
 * two-paths-one-appearance shape as the layout, and it deserves the same test — a colour that
 * looks right live and wrong after publishing is a genuinely confusing bug.
 *
 * The failure mode this is built to catch: adding a token to the palette and wiring it into only
 * one of the two paths. Both iterate THEME_TOKENS, so the assertion can name the missing one.
 */

/** Pull `--nh-*` declarations out of a single CSS block. */
function tokensIn(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector)
  if (at === -1) return {}
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  const out: Record<string, string> = {}
  for (const declaration of css.slice(open + 1, close).split(';')) {
    const [name, ...rest] = declaration.split(':')
    if (name?.startsWith('--nh-') === true) out[name.slice('--nh-'.length)] = rest.join(':')
  }
  return out
}

describe('every token reaches both paths', () => {
  const theme = themeSchema.parse({})

  it('emits exactly the tokens the runtime applier would write, for light', () => {
    const baked = tokensIn(themeVariables(theme), ':root{')
    const runtime = resolveTokens(theme, 'light')
    for (const token of ALL_TOKENS) {
      expect(baked[token], `token "${token}" is missing from the baked stylesheet`).toBe(
        runtime[token],
      )
    }
    // And nothing extra: a token in the stylesheet that the applier does not know about would
    // silently revert the moment the editor touched the theme.
    expect(Object.keys(baked).sort()).toEqual([...ALL_TOKENS].sort())
  })

  it('emits exactly the tokens the runtime applier would write, for dark', () => {
    const baked = tokensIn(themeVariables(theme), ':root[data-theme="dark"]')
    const runtime = resolveTokens(theme, 'dark')
    for (const token of ALL_TOKENS) {
      expect(baked[token], `token "${token}" is missing from the dark stylesheet`).toBe(
        runtime[token],
      )
    }
    expect(Object.keys(baked).sort()).toEqual([...ALL_TOKENS].sort())
  })

  it('agrees on a user override, not just on the defaults', () => {
    const custom = themeSchema.parse({
      cssVars: { light: { accent: 'oklch(0.6 0.2 20)' }, dark: { accent: 'oklch(0.8 0.2 20)' } },
    })
    expect(tokensIn(themeVariables(custom), ':root{').accent).toBe(
      resolveTokens(custom, 'light').accent,
    )
    expect(tokensIn(themeVariables(custom), ':root[data-theme="dark"]').accent).toBe(
      resolveTokens(custom, 'dark').accent,
    )
  })

  it('lets the shared block win over a per-scheme value in both paths', () => {
    // `cssVars.theme` is scheme-independent: a font or a radius. If the two paths disagreed about
    // its precedence, a shared override would apply live and vanish on publish.
    const custom = themeSchema.parse({
      cssVars: { light: { accent: 'red' }, dark: { accent: 'blue' }, theme: { accent: 'green' } },
    })
    expect(resolveTokens(custom, 'light').accent).toBe('green')
    expect(resolveTokens(custom, 'dark').accent).toBe('green')
    expect(tokensIn(themeVariables(custom), ':root{').accent).toBe('green')
    expect(tokensIn(themeVariables(custom), ':root[data-theme="dark"]').accent).toBe('green')
  })
})

describe('the palettes themselves', () => {
  it('define every token in both schemes', () => {
    for (const token of THEME_TOKENS) {
      expect(LIGHT_DEFAULTS[token], `light default missing for "${token}"`).toBeTruthy()
      expect(DARK_DEFAULTS[token], `dark default missing for "${token}"`).toBeTruthy()
    }
  })

  it('actually differ between light and dark, so a dark page is not a light one', () => {
    // A copy-pasted palette passes every other check here and produces an unreadable dark mode.
    const identical = THEME_TOKENS.filter((token) => LIGHT_DEFAULTS[token] === DARK_DEFAULTS[token])
    expect(identical).toEqual([])
  })
})
