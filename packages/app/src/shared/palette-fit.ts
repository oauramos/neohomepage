import {
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  formatInGamut,
  parseOklch,
  toHex,
} from './contrast.ts'

/**
 * Repairs a palette's contrast by walking each failing token's OKLCH lightness; hue and chroma are
 * never touched. The rule matrix is the one `theme-contrast.test.ts` asserts.
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

/** Everything text can sit on. `muted` is the worst case and the one a palette is solved for. */
const SURFACES = ['background', 'surface', 'muted'] as const

export type ContrastRule = {
  readonly foreground: string
  readonly background: string
  readonly floor: number
}

export const CONTRAST_RULES: readonly ContrastRule[] = [
  ...TEXT_TOKENS.flatMap((foreground) =>
    SURFACES.map((background) => ({ foreground, background, floor: AA_NORMAL_TEXT })),
  ),
  // The one pair where both sides move: a button's label on its own fill.
  { foreground: 'accent-foreground', background: 'accent', floor: AA_NORMAL_TEXT },
  // WCAG 1.4.11: inputs have a transparent fill, so the border alone marks a field; axe does not
  // check this rule.
  ...SURFACES.map((background) => ({
    foreground: 'control-border',
    background,
    floor: AA_NON_TEXT,
  })),
]

/**
 * Solve order. `accent-foreground` is last because its only surface, `accent`, may itself have
 * moved. Surfaces are never fitted: they are the design.
 */
const FITTABLE = [...TEXT_TOKENS, 'control-border', 'accent-foreground'] as const

export type Adjustment = {
  readonly token: string
  readonly from: string
  readonly to: string
  /** Hex on both sides, because that is the form the value arrived in and will be read back in. */
  readonly fromHex: string | null
  readonly toHex: string | null
  readonly reason: string
  /** False when no lightness in range satisfies every rule; the nearest miss is applied anyway. */
  readonly resolved: boolean
  /** Set when the colour was also pulled into the sRGB gamut, which changes what a screen shows. */
  readonly chromaReduced?: boolean
}

export type ContrastCheck = ContrastRule & {
  readonly ratio: number | null
  readonly passes: boolean
}

export function contrastChecks(tokens: Readonly<Record<string, string>>): ContrastCheck[] {
  return CONTRAST_RULES.map((rule) => {
    const ratio = contrastRatio(tokens[rule.foreground] ?? '', tokens[rule.background] ?? '')
    return { ...rule, ratio, passes: ratio !== null && ratio >= rule.floor }
  })
}

export function contrastFailures(tokens: Readonly<Record<string, string>>): ContrastCheck[] {
  return contrastChecks(tokens).filter((check) => !check.passes)
}

const STEP = 0.0025

// Lightness candidates nearest first, so the first that passes is the smallest move; both
// directions, because a token can sit on a light and a dark surface at once.
function candidates(lightness: number): number[] {
  const out: number[] = [lightness]
  for (let offset = STEP; offset <= 1; offset += STEP) {
    const down = lightness - offset
    const up = lightness + offset
    if (down >= 0) out.push(down)
    if (up <= 1) out.push(up)
  }
  return out
}

// Chroma is clamped per candidate: moving lightness at fixed chroma can leave the sRGB gamut,
// where the computed ratio and the painted one diverge.
function candidateAt(lightness: number, chroma: number, hue: number): string {
  return formatInGamut(lightness, chroma, hue)
}

function chromaShrank(from: string, to: string): boolean {
  return (parseOklch(to)?.c ?? 0) < (parseOklch(from)?.c ?? 0) - 0.0005
}

/**
 * Failing-rule count first, then the worst margin: maximising the minimum alone lets an unsolvable
 * palette drag a passing pair down and count it as an improvement. Rules whose surface is not a
 * colour are skipped; a candidate that is not a colour scores null.
 */
type Score = {
  readonly fails: number
  readonly worst: number
  readonly worstRule: ContrastRule
  readonly worstRatio: number
}

function score(
  value: string,
  rules: readonly ContrastRule[],
  tokens: Readonly<Record<string, string>>,
): Score | null {
  if (parseOklch(value) === null) return null
  let fails = 0
  let worst: { margin: number; rule: ContrastRule; ratio: number } | null = null
  for (const rule of rules) {
    const ratio = contrastRatio(value, tokens[rule.background] ?? '')
    if (ratio === null) continue
    const margin = ratio / rule.floor
    if (margin < 1) fails += 1
    if (worst === null || margin < worst.margin) worst = { margin, rule, ratio }
  }
  return worst === null
    ? null
    : { fails, worst: worst.margin, worstRule: worst.rule, worstRatio: worst.ratio }
}

/** Fewer failures wins; a tie goes to the one whose worst pair has the most room. */
function better(candidate: Score, incumbent: Score): boolean {
  return candidate.fails !== incumbent.fails
    ? candidate.fails < incumbent.fails
    : candidate.worst > incumbent.worst
}

function describe(token: string, before: Score): string {
  return (
    `${token} on ${before.worstRule.background} was ${before.worstRatio.toFixed(2)}:1, ` +
    `below ${String(before.worstRule.floor)}:1`
  )
}

/** A token the walk cannot help, and why. */
export type Unfittable = { readonly token: string; readonly why: string }

export type FitResult = {
  tokens: Record<string, string>
  adjustments: Adjustment[]
  unfittable: Unfittable[]
}

// One pass; `fitPalette` runs it to a fixed point, since moving a token changes what later ones
// are solved against and near black luminance is not monotonic in lightness.
function fitOnce(tokens: Readonly<Record<string, string>>): FitResult {
  const fitted: Record<string, string> = { ...tokens }
  const adjustments: Adjustment[] = []
  const unfittable: Unfittable[] = []

  // A surface that is not a colour takes every rule on it out of the walk, so report it instead of
  // returning "nothing to adjust".
  for (const token of new Set(
    CONTRAST_RULES.flatMap((rule) => [rule.foreground, rule.background]),
  )) {
    if (parseOklch(fitted[token] ?? '') === null) {
      unfittable.push({
        token,
        why: `${token} is not \`oklch(L C H)\`, so nothing can be measured against it`,
      })
    }
  }

  for (const token of FITTABLE) {
    const rules = CONTRAST_RULES.filter((rule) => rule.foreground === token)
    const from = fitted[token] ?? ''
    const before = score(from, rules, fitted)
    if (before === null || before.fails === 0) continue

    const current = parseOklch(from)
    if (current === null) continue

    const reason = describe(token, before)
    let best: { value: string; score: Score } | null = null
    let solved: string | null = null

    for (const lightness of candidates(current.l)) {
      const value = candidateAt(lightness, current.c, current.h)
      const candidateScore = score(value, rules, fitted)
      if (candidateScore === null) continue
      if (candidateScore.fails === 0) {
        solved = value
        break
      }
      if (best === null || better(candidateScore, best.score))
        best = { value, score: candidateScore }
    }

    const chosen = solved ?? (best !== null && better(best.score, before) ? best.value : undefined)
    if (chosen === undefined) {
      unfittable.push({ token, why: `${reason}, and no lightness of that hue clears it` })
      continue
    }

    adjustments.push({
      token,
      from,
      to: chosen,
      fromHex: toHex(from),
      toHex: toHex(chosen),
      reason,
      resolved: solved !== null,
      ...(chromaShrank(from, chosen) ? { chromaReduced: true } : {}),
    })
    fitted[token] = chosen
  }

  return { tokens: fitted, adjustments, unfittable }
}

/**
 * Walk each failing token's lightness until the matrix passes. Only failing tokens move, so a
 * passing palette comes back identical; runs to a fixed point (capped at three rounds) so the
 * output is a valid input to itself.
 */
export function fitPalette(tokens: Readonly<Record<string, string>>): FitResult {
  let fitted: Record<string, string> = { ...tokens }
  let unfittable: Unfittable[] = []
  // Keyed by token so a colour moved twice is reported once, from start to end.
  const moved = new Map<string, Adjustment>()

  for (let round = 0; round < 3; round += 1) {
    const pass = fitOnce(fitted)
    fitted = pass.tokens
    unfittable = pass.unfittable
    if (pass.adjustments.length === 0) break
    for (const adjustment of pass.adjustments) {
      const first = moved.get(adjustment.token)
      if (first === undefined) {
        moved.set(adjustment.token, adjustment)
        continue
      }
      moved.set(adjustment.token, {
        ...adjustment,
        from: first.from,
        fromHex: first.fromHex,
        reason: first.reason,
        ...(chromaShrank(first.from, adjustment.to) ? { chromaReduced: true } : {}),
      })
    }
  }

  return { tokens: fitted, adjustments: [...moved.values()], unfittable }
}
