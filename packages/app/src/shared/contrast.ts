/**
 * OKLCH to sRGB colour maths so theme tokens can be checked against WCAG contrast, which is
 * defined on sRGB luminance. Implemented inline: a colour library in the shared tree would ship to
 * the browser for a check that only runs in CI.
 */

type Rgb = { readonly r: number; readonly g: number; readonly b: number }

export type Oklch = { readonly l: number; readonly c: number; readonly h: number }

/**
 * Parse `oklch(L C H)`, the only form the token defaults use. The number pattern is strict so
 * `0.5.5` cannot reach `Number` and become a NaN that travels; lightness and chroma are
 * range-checked, hue is not because CSS treats it as modular.
 */
export function parseOklch(value: string): Oklch | null {
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
function oklchToLinearRgb(value: Oklch): Rgb {
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
function relativeLuminance(linear: Rgb): number {
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

/** `oklch(0.63 0.16 149)` -> `#2aa34f`. */
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
 * `#2aa34f` -> `oklch(0.63 0.16 149)`, the inverse of `toHex`. Stored tokens must stay OKLCH
 * because `parseOklch` is the only form `contrastRatio` reads. Returns null for anything that is
 * not a 3- or 6-digit hex.
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
  const channel = (at: number) => toLinear(Number.parseInt(full.slice(at, at + 2), 16) / 255)
  const r = channel(0)
  const g = channel(2)
  const b = channel(4)

  // Linear sRGB -> LMS -> OKLab: the inverse matrices of the pair in `oklchToLinearRgb`.
  const lCube = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const mCube = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const sCube = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(lCube)
  const m_ = Math.cbrt(mCube)
  const s_ = Math.cbrt(sCube)

  const lightness = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const bAxis = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_

  const chroma = Math.sqrt(a * a + bAxis * bAxis)
  // A neutral has no meaningful hue; pin it to 0 so floating-point noise cannot pick an angle.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360

  return formatOklch(lightness, chroma, hue)
}

/**
 * The only producer of a token's text form; `parseOklch` accepts exactly this shape (three
 * unitless numbers, no alpha).
 */
function formatOklch(lightness: number, chroma: number, hue: number): string {
  return `oklch(${lightness.toFixed(4)} ${chroma.toFixed(4)} ${hue.toFixed(2)})`
}

/**
 * Whether an sRGB screen can show the colour. `relativeLuminance` clips channels into [0,1] but a
 * browser gamut-maps by reducing chroma, so a ratio for an out-of-gamut value is for a colour
 * nobody sees (off by up to 0.8 of a point).
 */
export function inSrgbGamut(value: Oklch): boolean {
  const linear = oklchToLinearRgb(value)
  return [linear.r, linear.g, linear.b].every(
    (channel) => channel >= -0.00001 && channel <= 1.00001,
  )
}

/**
 * Largest chroma this lightness and hue can carry in sRGB, by bisection. Chroma is the axis a
 * browser gives up too; 24 halvings land within 0.00002 of the boundary.
 */
function clampChroma(value: Oklch): number {
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
 * A well-formed token string inside sRGB. Rounds first and clamps at the values that will be
 * written, flooring chroma, because rounding chroma up after clamping can step back outside; the
 * result parses back to exactly the numbers it was solved for.
 */
export function formatInGamut(lightness: number, chroma: number, hue: number): string {
  const l = Number(lightness.toFixed(4))
  const h = Number((hue % 360).toFixed(2))
  const c = Number(chroma.toFixed(4))
  // Flooring unconditionally loses a ten-thousandth of chroma to floating point
  // (`0.1944 * 1e4` is 1943.9999999) and breaks the hex round trip.
  if (inSrgbGamut({ l, c, h })) return formatOklch(l, c, h)
  return formatOklch(l, Math.floor(clampChroma({ l, c, h }) * 1e4) / 1e4, h)
}

/** AA for body text. */
export const AA_NORMAL_TEXT = 4.5
/** AA for UI components and graphical objects: borders, focus rings, a status dot. */
export const AA_NON_TEXT = 3
