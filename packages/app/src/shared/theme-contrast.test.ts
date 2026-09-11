import { describe, expect, it } from 'vitest'
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio, hexToOklch, toHex } from './contrast.ts'
import { resolveTokens } from './theme-tokens.ts'
import { ALL_PRESETS, SHAPE_TOKENS } from './theme-presets.ts'
import { themeSchema } from '../server/config/schema.ts'

/**
 * Contrast of every text token on every surface, in both schemes, checked as maths so a token used
 * only by a rare state is covered without a browser test having to render it.
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

// Resolved through `resolveTokens` so an omitted token is checked as the default it falls through
// to; `DEFAULT_PRESET` sets no colours, so `preset default` covers the raw defaults tables.
describe.each(ALL_PRESETS.map((preset) => [preset.id, preset] as const))(
  'preset %s',
  (id, preset) => {
    const theme = themeSchema.parse({ preset: id })

    describe.each(['light', 'dark'] as const)('%s', (scheme) => {
      const tokens = resolveTokens(theme, scheme)

      it.each(TEXT_TOKENS)('%s reads on every surface', (token) => {
        for (const surface of SURFACES) {
          const ratio = contrastRatio(tokens[token] ?? '', tokens[surface] ?? '')
          expect(
            ratio,
            `${preset.label} ${scheme}: ${token} ${toHex(tokens[token] ?? '')} on ${surface} ` +
              `${toHex(tokens[surface] ?? '')} is ${ratio?.toFixed(2)}:1, below AA's ${AA_NORMAL_TEXT}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        }
      })

      it('puts readable text on the accent fill', () => {
        const ratio = contrastRatio(tokens['accent-foreground'] ?? '', tokens.accent ?? '')
        expect(ratio ?? 0, `${preset.label} ${scheme}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
      })

      it('makes an input identifiable as an input', () => {
        for (const surface of SURFACES) {
          const ratio = contrastRatio(tokens['control-border'] ?? '', tokens[surface] ?? '')
          expect(
            ratio ?? 0,
            `${preset.label} ${scheme}: control-border on ${surface}`,
          ).toBeGreaterThanOrEqual(AA_NON_TEXT)
        }
      })

      it('has a focus ring that can be seen', () => {
        for (const surface of ['background', 'surface'] as const) {
          expect(
            contrastRatio(tokens.accent ?? '', tokens[surface] ?? '') ?? 0,
            `${preset.label} ${scheme}: accent on ${surface}`,
          ).toBeGreaterThanOrEqual(AA_NON_TEXT)
        }
      })

      it('sets every shape token to something', () => {
        // An unset shape token drops the CSS declaration silently.
        for (const token of SHAPE_TOKENS) {
          expect(tokens[token], `${preset.label} is missing ${token}`).toBeTruthy()
        }
      })
    })
  },
)

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

// The two directions use independently written matrices, so a round trip fails if either drifts.
describe('hex to oklch', () => {
  it.each(['#000000', '#ffffff', '#2aa34f', '#d8151e', '#38bdf8', '#0f172a', '#7f7f7f', '#ff00ff'])(
    'round-trips %s back to itself',
    (hex) => {
      const oklch = hexToOklch(hex)
      expect(oklch, `${hex} did not convert`).not.toBeNull()
      expect(toHex(oklch as string)).toBe(hex)
    },
  )

  it('accepts the three-digit form', () => {
    expect(toHex(hexToOklch('#f0a') as string)).toBe('#ff00aa')
  })

  it('produces a value the palette maths can actually read', () => {
    const ratio = contrastRatio(hexToOklch('#ffffff') as string, hexToOklch('#000000') as string)
    expect(ratio).toBeCloseTo(21, 1)
  })

  it('returns null for anything that is not a hex colour', () => {
    for (const bad of ['', '#', 'white', '#12345', '#gggggg', 'oklch(0.5 0.1 200)']) {
      expect(hexToOklch(bad), bad).toBeNull()
    }
  })
})
