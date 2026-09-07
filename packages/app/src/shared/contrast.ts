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

/** Parse `oklch(L C H)` — the only form the token defaults use. */
export function parseOklch(value: string): { l: number; c: number; h: number } | null {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim())
  if (match === null) return null
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) }
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

  return `oklch(${lightness.toFixed(4)} ${chroma.toFixed(4)} ${hue.toFixed(2)})`
}

/** AA for body text. Large text (18.66px bold / 24px) would be 3:1, which nothing here relies on. */
export const AA_NORMAL_TEXT = 4.5
/** AA for UI components and graphical objects: borders, focus rings, a status dot. */
export const AA_NON_TEXT = 3
