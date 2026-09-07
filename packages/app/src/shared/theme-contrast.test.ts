import { describe, expect, it } from 'vitest'
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio, toHex } from './contrast.ts'
import { DARK_DEFAULTS, LIGHT_DEFAULTS, THEME_TOKENS } from './theme-tokens.ts'

/**
 * The theme's contrast, checked as maths rather than waited for from axe.
 *
 * axe only judges what a page happens to render, so a token used by one rare state — the "warn"
 * tone on a stat, say — can fail for months before a browser test lands on it. Here every token
 * that can carry text is checked against every surface it can sit on, in both schemes, and the
 * failure names the pair and the ratio.
 */

/** Tokens used as text colour anywhere in the stylesheet or the baked theme. */
const TEXT_TOKENS = [
  'foreground',
  'surface-foreground',
  'muted-foreground',
  'ok',
  'warn',
  'bad',
  'accent',
] as const

/** Everything text can sit on. `muted` is the worst case and the one the palette is solved for. */
const SURFACES = ['background', 'surface', 'muted'] as const

describe.each([
  ['light', LIGHT_DEFAULTS],
  ['dark', DARK_DEFAULTS],
] as const)('%s', (scheme, tokens) => {
  it.each(TEXT_TOKENS)('%s reads on every surface', (token) => {
    for (const surface of SURFACES) {
      const ratio = contrastRatio(tokens[token], tokens[surface])
      expect(ratio, `${scheme}: ${token} (${toHex(tokens[token])}) on ${surface}`).not.toBeNull()
      expect(
        ratio,
        `${scheme}: ${token} ${toHex(tokens[token])} on ${surface} ${toHex(tokens[surface])} is ` +
          `${ratio?.toFixed(2)}:1, below AA's ${AA_NORMAL_TEXT}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }
  })

  it('puts readable text on the accent fill', () => {
    // Buttons: `accent-foreground` on `accent`, which is the one pair where both sides move.
    const ratio = contrastRatio(tokens['accent-foreground'], tokens.accent)
    expect(ratio ?? 0).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('makes an input identifiable as an input', () => {
    // WCAG 1.4.11: 3:1 for the visual information that identifies a component. Our inputs have a
    // transparent fill, so the border is the ONLY thing saying "this is a field" — and axe does
    // not evaluate 1.4.11 automatically, so nothing else would have caught it at 1.25:1.
    for (const surface of SURFACES) {
      const ratio = contrastRatio(tokens['control-border'], tokens[surface])
      expect(
        ratio ?? 0,
        `${scheme}: control-border on ${surface} is ${ratio?.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })

  it('has a focus ring that can be seen', () => {
    // The focus outline is `accent`, and losing track of focus is the failure mode that makes a
    // keyboard-only session impossible rather than merely awkward.
    expect(contrastRatio(tokens.accent, tokens.background) ?? 0).toBeGreaterThanOrEqual(AA_NON_TEXT)
    expect(contrastRatio(tokens.accent, tokens.surface) ?? 0).toBeGreaterThanOrEqual(AA_NON_TEXT)
  })

  it('defines every token in the contract', () => {
    // The token list is the contract between the baked stylesheet and the runtime applier; a
    // token added to one scheme and not the other is a colour that changes when the OS theme does.
    for (const token of THEME_TOKENS) {
      expect(tokens[token], `${scheme} is missing ${token}`).toBeTruthy()
    }
  })
})

describe('the conversion itself', () => {
  it('agrees with a known sRGB value', () => {
    // Pure white and pure black: 21:1, the definition's own maximum.
    expect(contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)')).toBeCloseTo(21, 1)
  })

  it('renders a token as a hex a human can look up', () => {
    expect(toHex('oklch(1 0 0)')).toBe('#ffffff')
    expect(toHex('oklch(0 0 0)')).toBe('#000000')
  })

  it('returns null for anything it cannot parse, rather than a wrong number', () => {
    expect(contrastRatio('#ff0000', 'oklch(1 0 0)')).toBeNull()
    expect(toHex('rebeccapurple')).toBeNull()
  })
})
