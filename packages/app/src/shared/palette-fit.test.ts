import { describe, expect, it } from 'vitest'
import { formatInGamut, hexToOklch, inSrgbGamut, parseOklch, toHex } from './contrast.ts'
import { contrastChecks, contrastFailures, fitPalette } from './palette-fit.ts'
import { ALL_PRESETS } from './theme-presets.ts'
import { DARK_DEFAULTS, LIGHT_DEFAULTS, THEME_TOKENS } from './theme-tokens.ts'

function fromHex(colours: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(colours).map(([token, hex]) => [token, hexToOklch(hex) as string]),
  )
}

/** Chosen to look like a brand, not to pass AA. */
const BRAND = fromHex({
  background: '#ffffff',
  foreground: '#1d1d1f',
  surface: '#ffffff',
  'surface-foreground': '#1d1d1f',
  muted: '#f5f5f7',
  'muted-foreground': '#86868b',
  border: '#d2d2d7',
  'control-border': '#d2d2d7',
  accent: '#0071e3',
  'accent-foreground': '#ffffff',
  ok: '#34c759',
  warn: '#ff9f0a',
  bad: '#ff3b30',
})

describe('the shipped palettes', () => {
  it.each(ALL_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s already passes, so nothing moves',
    (id, preset) => {
      for (const [scheme, defaults] of [
        ['light', LIGHT_DEFAULTS],
        ['dark', DARK_DEFAULTS],
      ] as const) {
        const tokens = { ...defaults, ...preset[scheme] }
        const { adjustments } = fitPalette(tokens)
        expect(
          adjustments.map((entry) => `${entry.token}: ${entry.reason}`),
          `${id} (${scheme}) should already be readable`,
        ).toEqual([])
      }
    },
  )
})

describe('a brand palette', () => {
  const { tokens, adjustments } = fitPalette(BRAND)

  it('comes back passing every rule the suite asserts', () => {
    expect(
      contrastFailures(tokens).map(
        (check) =>
          `${check.foreground} on ${check.background} is ${check.ratio?.toFixed(2) ?? '—'}:1, ` +
          `below ${String(check.floor)}:1`,
      ),
    ).toEqual([])
  })

  it('moves the tokens that failed and leaves the rest alone', () => {
    // The muted label and control border fail on the inset grey; the greys and blue are the brand.
    const moved = adjustments.map((entry) => entry.token).sort()
    expect(moved).toContain('muted-foreground')
    expect(moved).toContain('control-border')
    expect(moved).not.toContain('foreground')
    expect(tokens.background).toBe(BRAND.background)
    expect(tokens.surface).toBe(BRAND.surface)
    expect(tokens.muted).toBe(BRAND.muted)
  })

  it('keeps the hue, because that is what makes it their colour', () => {
    for (const adjustment of adjustments) {
      const before = parseOklch(adjustment.from)
      const after = parseOklch(adjustment.to)
      expect(after?.h).toBeCloseTo(before?.h ?? 0, 6)
      expect(after?.l).not.toBe(before?.l)
      // Chroma is held unless holding it would leave the sRGB gamut.
      if (adjustment.chromaReduced === true) {
        expect(after?.c ?? 0).toBeLessThan(before?.c ?? 0)
      } else {
        expect(after?.c).toBeCloseTo(before?.c ?? 0, 6)
      }
    }
  })

  it('only ever writes a colour a screen can show', () => {
    for (const adjustment of adjustments) {
      const parsed = parseOklch(adjustment.to)
      expect(parsed, adjustment.to).not.toBeNull()
      expect(parsed !== null && inSrgbGamut(parsed), adjustment.to).toBe(true)
    }
  })

  it('reports each move in terms of the pair that failed', () => {
    for (const adjustment of adjustments) {
      expect(adjustment.reason).toMatch(/ on .+ was \d+\.\d\d:1, below (3|4\.5):1$/)
      expect(adjustment.resolved).toBe(true)
      expect(adjustment.fromHex).toMatch(/^#[0-9a-f]{6}$/)
      expect(adjustment.toHex).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('is a fixed point: fitting a fitted palette changes nothing', () => {
    expect(fitPalette(tokens).adjustments).toEqual([])
  })
})

describe('the dark side of the same brand', () => {
  // A label too dark on white is too dark on charcoal too, but the fix goes the other way.
  const DARK_BRAND = {
    ...BRAND,
    ...fromHex({
      background: '#000000',
      surface: '#1c1c1e',
      muted: '#2c2c2e',
      foreground: '#f5f5f7',
      'surface-foreground': '#f5f5f7',
      'accent-foreground': '#000000',
    }),
  }
  const { tokens, adjustments } = fitPalette(DARK_BRAND)

  it('lightens rather than darkens, and passes', () => {
    expect(contrastFailures(tokens)).toEqual([])
    const label = adjustments.find((entry) => entry.token === 'muted-foreground')
    expect(parseOklch(label?.to ?? '')?.l ?? 0).toBeGreaterThan(
      parseOklch(label?.from ?? '')?.l ?? 1,
    )
  })
})

describe('what it refuses to guess at', () => {
  it('leaves a token it cannot parse alone rather than inventing one', () => {
    const tokens = { ...LIGHT_DEFAULTS, accent: 'rebeccapurple' }
    const { adjustments, tokens: out, unfittable } = fitPalette(tokens)
    expect(adjustments).toEqual([])
    expect(out.accent).toBe('rebeccapurple')
    expect(contrastFailures(out).some((check) => check.foreground === 'accent')).toBe(true)
    expect(unfittable.map((entry) => entry.token)).toContain('accent')
  })

  it('never certifies a value that is not a colour', () => {
    // `0.5.5` must be rejected, not parsed to a NaN that scores every candidate as passing.
    const { adjustments, unfittable } = fitPalette({
      ...LIGHT_DEFAULTS,
      accent: 'oklch(0.5.5 0.1 200)',
    })
    expect(adjustments).toEqual([])
    expect(unfittable.map((entry) => entry.token)).toContain('accent')
  })

  it('says so when a surface is the thing it cannot read', () => {
    // A hex surface reaches here through the theme-import box.
    const { adjustments, unfittable } = fitPalette({ ...LIGHT_DEFAULTS, muted: '#1d282b' })
    expect(adjustments).toEqual([])
    expect(unfittable.map((entry) => entry.token)).toEqual(['muted'])
  })

  it('grades a complete palette without touching it', () => {
    const checks = contrastChecks(LIGHT_DEFAULTS)
    expect(checks.every((check) => check.passes)).toBe(true)
    // Every token but `border` is on one side of the matrix, so a new token cannot go unchecked.
    const named = new Set(checks.flatMap((check) => [check.foreground, check.background]))
    expect([...THEME_TOKENS].filter((token) => !named.has(token))).toEqual(['border'])
  })
})

describe('a palette with nowhere to go', () => {
  // Nothing clears 4.5:1 against white, black and mid-grey at once, so every token is a near miss.
  const tokens = {
    ...LIGHT_DEFAULTS,
    ...fromHex({ background: '#ffffff', surface: '#000000', muted: '#808080' }),
  }
  const { adjustments, tokens: out } = fitPalette(tokens)

  it('applies the nearest miss and says it is unresolved', () => {
    expect(adjustments.length).toBeGreaterThan(0)
    expect(adjustments.some((entry) => !entry.resolved)).toBe(true)
    expect(toHex(out.foreground as string)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('leaves fewer pairs failing than it found, never more', () => {
    expect(contrastFailures(out).length).toBeLessThan(contrastFailures(tokens).length)
  })

  it('is a fixed point even here, so two identical calls write one theme', () => {
    expect(fitPalette(out).adjustments).toEqual([])
  })
})

describe('any palette at all', () => {
  // CPU-bound: 1.6s on a warm laptop, past the 5s default on a busy two-core CI runner.
  it('never comes back with more failing pairs than it went in with', { timeout: 30_000 }, () => {
    // 150 random palettes is enough: the failure this guards is systematic, not rare.
    let seed = 20260907
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const tokens = Object.fromEntries(
        THEME_TOKENS.map((token) => [
          token,
          formatInGamut(random(), random() * 0.3, random() * 360),
        ]),
      )
      const fitted = fitPalette(tokens)
      expect(
        contrastFailures(fitted.tokens).length,
        `palette ${String(attempt)} got worse`,
      ).toBeLessThanOrEqual(contrastFailures(tokens).length)
    }
  })
})
