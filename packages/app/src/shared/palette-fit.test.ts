import { describe, expect, it } from 'vitest'
import { formatInGamut, hexToOklch, inSrgbGamut, parseOklch, toHex } from './contrast.ts'
import { contrastChecks, contrastFailures, fitPalette } from './palette-fit.ts'
import { ALL_PRESETS } from './theme-presets.ts'
import { DARK_DEFAULTS, LIGHT_DEFAULTS, THEME_TOKENS } from './theme-tokens.ts'

/**
 * The solver, checked against the thing it exists to guarantee.
 *
 * The claim is narrow and worth proving rather than trusting: a palette that arrives from outside —
 * an agent reading a brand's colours off a website — comes back readable, still recognisably that
 * brand, and passing the same matrix `theme-contrast.test.ts` runs over the shipped presets.
 */

function fromHex(colours: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(colours).map(([token, hex]) => [token, hexToOklch(hex) as string]),
  )
}

/** A brand palette of the kind this exists for: chosen to look like a brand, not to pass AA. */
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
  it.each(ALL_PRESETS.map((preset) => preset.id))('%s already passes, so nothing moves', (id) => {
    const preset = ALL_PRESETS.find((entry) => entry.id === id)
    for (const [scheme, defaults] of [
      ['light', LIGHT_DEFAULTS],
      ['dark', DARK_DEFAULTS],
    ] as const) {
      const tokens = { ...defaults, ...preset?.[scheme] }
      const { adjustments } = fitPalette(tokens)
      expect(
        adjustments.map((entry) => `${entry.token}: ${entry.reason}`),
        `${id} (${scheme}) should already be readable`,
      ).toEqual([])
    }
  })
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
    // The greys and the blue are the point of the brand; the muted label and the status colours
    // are what a brand never picks for a 4.5:1 floor on an inset grey.
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
      // Chroma is held too, unless holding it would have left the sRGB gamut — in which case it
      // is reduced, and the adjustment says so rather than reporting a colour no screen shows.
      if (adjustment.chromaReduced === true) {
        expect(after?.c ?? 0).toBeLessThan(before?.c ?? 0)
      } else {
        expect(after?.c).toBeCloseTo(before?.c ?? 0, 6)
      }
    }
  })

  it('only ever writes a colour a screen can show', () => {
    // The ratios this module reports are computed by clipping sRGB channels; a browser instead
    // reduces chroma. The two agree only inside the gamut, so staying inside it is what makes the
    // reported number and the rendered number the same number.
    for (const adjustment of adjustments) {
      expect(inSrgbGamut(parseOklch(adjustment.to) as never), adjustment.to).toBe(true)
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
  // The same hues on a dark canvas move the other way, which is the case a one-direction walk
  // would have got wrong: a label that is too dark on white is too dark on charcoal too, but the
  // fix is to lighten it, not to darken it further.
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
    expect((parseOklch(label?.to ?? '')?.l ?? 0) > (parseOklch(label?.from ?? '')?.l ?? 1)).toBe(
      true,
    )
  })
})

describe('what it refuses to guess at', () => {
  it('leaves a token it cannot parse alone rather than inventing one', () => {
    const tokens = { ...LIGHT_DEFAULTS, accent: 'rebeccapurple' }
    const { adjustments, tokens: out, unfittable } = fitPalette(tokens)
    expect(adjustments).toEqual([])
    expect(out.accent).toBe('rebeccapurple')
    // And it still shows up, as a failure and as something it could not fix — not as silence.
    expect(contrastFailures(out).some((check) => check.foreground === 'accent')).toBe(true)
    expect(unfittable.map((entry) => entry.token)).toContain('accent')
  })

  it('never certifies a value that is not a colour', () => {
    // `oklch(0.5.5 …)` parsed to NaN, every candidate scored "no rule failed", and the walk
    // reported the first one — the current value, re-serialised — as a solve.
    const { adjustments, unfittable } = fitPalette({
      ...LIGHT_DEFAULTS,
      accent: 'oklch(0.5.5 0.1 200)',
    })
    expect(adjustments).toEqual([])
    expect(unfittable.map((entry) => entry.token)).toContain('accent')
  })

  it('says so when a surface is the thing it cannot read', () => {
    // A hex surface is reachable today through the theme-import box, and the walk has nothing to
    // solve against. Reporting nothing here read as "your palette is fine" beside 8 failures.
    const { adjustments, unfittable } = fitPalette({ ...LIGHT_DEFAULTS, muted: '#1d282b' })
    expect(adjustments).toEqual([])
    expect(unfittable.map((entry) => entry.token)).toEqual(['muted'])
  })

  it('grades a complete palette without touching it', () => {
    const checks = contrastChecks(LIGHT_DEFAULTS)
    expect(checks.every((check) => check.passes)).toBe(true)
    // Every colour token in the contract appears on one side of the matrix or the other, so a
    // token added to the palette cannot be one nothing ever checks.
    const named = new Set(checks.flatMap((check) => [check.foreground, check.background]))
    expect([...THEME_TOKENS].filter((token) => !named.has(token))).toEqual(['border'])
  })
})

describe('a palette with nowhere to go', () => {
  // A white page, a black tile and a mid-grey inset: no lightness of any hue clears 4.5:1 against
  // all three at once, so every token here is a near miss and this is where a solver misbehaves.
  const tokens = {
    ...LIGHT_DEFAULTS,
    background: hexToOklch('#ffffff') as string,
    surface: hexToOklch('#000000') as string,
    muted: hexToOklch('#808080') as string,
  }
  const { adjustments, tokens: out } = fitPalette(tokens)

  it('applies the nearest miss and says it is unresolved', () => {
    expect(adjustments.length).toBeGreaterThan(0)
    expect(adjustments.some((entry) => !entry.resolved)).toBe(true)
    // It still had to produce a colour rather than throw, and a readable one where it could.
    expect(toHex(out.foreground as string)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('leaves fewer pairs failing than it found, never more', () => {
    // Scoring a candidate by its worst ratio alone — maximise the minimum — passed this test's
    // sibling above while doing the opposite of its job here: it repaired nothing, dragged
    // control-border from 6.11:1 to 2.30:1, and called all eight moves fixes. Counting failures
    // first is what makes an improvement mean what the word means.
    expect(contrastFailures(out).length).toBeLessThan(contrastFailures(tokens).length)
  })

  it('is a fixed point even here, so two identical calls write one theme', () => {
    expect(fitPalette(out).adjustments).toEqual([])
  })
})

describe('any palette at all', () => {
  it('never comes back with more failing pairs than it went in with', () => {
    // The property the solver actually promises, over palettes nobody would author: random ones,
    // including plenty whose surfaces cannot carry text at all. A hundred and fifty rather than
    // the thousands this was developed against — the failure it guards is systematic, not rare,
    // and a suite that runs in six seconds is one people run.
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
