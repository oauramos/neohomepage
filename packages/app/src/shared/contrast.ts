/**
 * Colour maths, so the theme's contrast is a test rather than an opinion.
 *
 * The tokens are authored in OKLCH because it is the space where "same lightness" looks like the
 * same lightness. WCAG contrast, though, is defined on sRGB relative luminance — a different
 * quantity — so a palette that looks evenly weighted can still fail AA. Converting here lets the
 * theme test say WHICH token pair fails and by how much, instead of waiting for axe to happen to
 * render the one element that uses it.
 *
 * Implemented rather than pulled in: this is forty lines of published matrices, and a colour
 * library in the shared tree would be shipped to the browser for a check that only runs in CI.
 */

export type Rgb = { readonly r: number; readonly g: number; readonly b: number }

/**
 * Parse `oklch(L C H)` — the only form the token defaults use.
 *
 * The number pattern is `\d+(\.\d+)?` and not `[\d.]+`, which is a one-character difference with
 * a long tail: `[\d.]+` matches `0.5.5`, `Number` turns that into `NaN`, and NaN then travels. It
 * is not caught downstream either — `contrastRatio` returns NaN rather than null, so a ratio
 * reads "NaN:1" instead of "—", `toHex` returns `#NaNNaNNaN`, and a solver looking for a value
 * that clears a floor finds every candidate equally hopeless and calls the first one a solution.
 * Lightness and chroma are range-checked for the same reason: `oklch(9 0 0)` is not a colour, and
 * the honest answer to it is the same as to `rebeccapurple`. Hue is NOT — it is modular in CSS, so
 * `oklch(0.5 0.1 400)` is a perfectly good colour a browser paints as hue 40. Rejecting it made the
 * panel read "—" and the design tools refuse a value the board renders fine, which is the
 * report-disagrees-with-the-screen failure this module exists to prevent.
 */
export function parseOklch(value: string): { l: number; c: number; h: number } | null {
  const match = /^oklch\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\)$/.exec(
    value.trim(),
  )
  if (match === null) return null
  const l = Number(match[1])
  const c = Number(match[2])
  const h = Number(match[3])
  if (l > 1 || c > 0.5) return null
  return { l, c, h: h % 360 }
}

/** OKLCH to LINEAR sRGB. Linear is what luminance is defined on; no gamma is applied. */
export function oklchToLinearRgb(value: { l: number; c: number; h: number }): Rgb {
  const hRad = (value.h * Math.PI) / 180
  const a = value.c * Math.cos(hRad)
  const b = value.c * Math.sin(hRad)

  const lCube = (value.l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mCube = (value.l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sCube = (value.l - 0.0894841775 * a - 1.291485548 * b) ** 3

  return {
    r: 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    g: -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    b: -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  }
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** WCAG 2.x relative luminance. */
export function relativeLuminance(linear: Rgb): number {
  return 0.2126 * clamp(linear.r) + 0.7152 * clamp(linear.g) + 0.0722 * clamp(linear.b)
}

export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseOklch(foreground)
  const bg = parseOklch(background)
  if (fg === null || bg === null) return null
  const a = relativeLuminance(oklchToLinearRgb(fg))
  const b = relativeLuminance(oklchToLinearRgb(bg))
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/** For a message a human can act on: `oklch(0.63 0.16 149)` -> `#2aa34f`. */
export function toHex(value: string): string | null {
  const parsed = parseOklch(value)
  if (parsed === null) return null
  const linear = oklchToLinearRgb(parsed)
  const encode = (channel: number) => {
    const c = clamp(channel)
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${encode(linear.r)}${encode(linear.g)}${encode(linear.b)}`
}

/**
 * `#2aa34f` -> `oklch(0.63 0.16 149)`, the inverse of `toHex`.
 *
 * The design panel offers a colour picker and a hex field because that is how people think about
 * colour, but a token has to stay OKLCH: `parseOklch` is the only form `contrastRatio` reads, and
 * a hex value stored in `cssVars` would make every ratio in the panel and in
 * `theme-contrast.test.ts` come back null — which the test counts as a failure. Converting on the
 * way IN keeps the picker friendly and the stored palette checkable.
 *
 * Returns null for anything that is not a 3- or 6-digit hex, rather than a plausible wrong colour.
 */
export function hexToOklch(value: string): string | null {
  const hex = value.trim().replace(/^#/, '')
  const full =
    hex.length === 3
      ? [...hex].map((character) => character + character).join('')
      : hex.length === 6
        ? hex
        : null
  if (full === null || !/^[0-9a-fA-F]{6}$/.test(full)) return null

  // sRGB -> linear, undoing the same transfer function `toHex` applies.
  const toLinear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  const [r, g, b] = [0, 2, 4].map((at) =>
    toLinear(Number.parseInt(full.slice(at, at + 2), 16) / 255),
  )

  // Linear sRGB -> LMS -> OKLab: the inverse matrices of the pair in `oklchToLinearRgb`.
  const lCube = 0.4122214708 * (r ?? 0) + 0.5363325363 * (g ?? 0) + 0.0514459929 * (b ?? 0)
  const mCube = 0.2119034982 * (r ?? 0) + 0.6806995451 * (g ?? 0) + 0.1073969566 * (b ?? 0)
  const sCube = 0.0883024619 * (r ?? 0) + 0.2817188376 * (g ?? 0) + 0.6299787005 * (b ?? 0)
  const l_ = Math.cbrt(lCube)
  const m_ = Math.cbrt(mCube)
  const s_ = Math.cbrt(sCube)

  const lightness = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const bAxis = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_

  const chroma = Math.sqrt(a * a + bAxis * bAxis)
  // A neutral has no meaningful hue; pinning it to 0 keeps the round trip stable instead of
  // letting floating-point noise pick an arbitrary angle.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360

  return formatOklch(lightness, chroma, hue)
}

/**
 * The one place a token's text form is produced.
 *
 * `parseOklch` above is the only reader, and it accepts a narrow shape — three space-separated
 * numbers, no units, no alpha. Anything that builds a token by hand is one comma away from a value
 * that stores fine and then makes every ratio in the design panel read "—", so nothing builds one
 * by hand.
 */
export function formatOklch(lightness: number, chroma: number, hue: number): string {
  return `oklch(${lightness.toFixed(4)} ${chroma.toFixed(4)} ${hue.toFixed(2)})`
}

/**
 * Whether a colour is one an sRGB screen can actually show.
 *
 * It matters because `relativeLuminance` above CLIPS each channel into [0,1] after the matrix,
 * and a browser does not: CSS gamut-maps an out-of-range `oklch()` by pulling chroma down at
 * constant lightness and hue, which lands on a different colour with a different luminance. So a
 * ratio computed here for an out-of-gamut value is a ratio for a colour nobody will see — measured
 * at up to 0.8 of a point, which is the difference between passing AA and only appearing to.
 *
 * Every colour these tools write is brought inside the gamut first, which is what makes the number
 * they report the number the screen shows.
 */
export function inSrgbGamut(value: { l: number; c: number; h: number }): boolean {
  const linear = oklchToLinearRgb(value)
  return [linear.r, linear.g, linear.b].every(
    (channel) => channel >= -0.00001 && channel <= 1.00001,
  )
}

/**
 * The largest chroma this lightness and hue can carry in sRGB, found by bisection.
 *
 * Chroma is the axis to give up because it is the one a browser gives up: reducing it holds the
 * hue and the lightness, which are what make a colour recognisably itself. Twenty-four halvings
 * put the answer within 0.00002 of the boundary, which is far below what a screen resolves.
 */
export function clampChroma(value: { l: number; c: number; h: number }): number {
  if (inSrgbGamut(value)) return value.c
  let low = 0
  let high = value.c
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    if (inSrgbGamut({ ...value, c: mid })) low = mid
    else high = mid
  }
  return low
}

/**
 * A token string that is both well-formed and inside sRGB — the only producer these tools use.
 *
 * Doing this in one place is what makes the guarantee hold: `clampChroma` finds the boundary for a
 * given lightness and hue, but `formatOklch` then ROUNDS, and rounding chroma up by 0.00005 steps
 * back outside. So the rounding is done first, the clamp is solved at the values that will
 * actually be written, and the chroma is floored rather than rounded. The string this returns
 * parses back to exactly the numbers it was solved for.
 */
export function formatInGamut(lightness: number, chroma: number, hue: number): string {
  const l = Number(lightness.toFixed(4))
  const h = Number((hue % 360).toFixed(2))
  const c = Number(chroma.toFixed(4))
  // Only a colour actually outside gets moved. Flooring unconditionally cost a ten-thousandth of
  // chroma on values already inside — `0.1944 * 1e4` is 1943.9999999 in binary floating point —
  // which broke the hex round trip for one colour in twenty, for nothing.
  if (inSrgbGamut({ l, c, h })) return formatOklch(l, c, h)
  return formatOklch(l, Math.floor(clampChroma({ l, c, h }) * 1e4) / 1e4, h)
}

/** AA for body text. Large text (18.66px bold / 24px) would be 3:1, which nothing here relies on. */
export const AA_NORMAL_TEXT = 4.5
/** AA for UI components and graphical objects: borders, focus rings, a status dot. */
export const AA_NON_TEXT = 3
