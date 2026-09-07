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

/** AA for body text. Large text (18.66px bold / 24px) would be 3:1, which nothing here relies on. */
export const AA_NORMAL_TEXT = 4.5
/** AA for UI components and graphical objects: borders, focus rings, a status dot. */
export const AA_NON_TEXT = 3
