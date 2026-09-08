import {
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  formatInGamut,
  parseOklch,
  toHex,
} from './contrast.ts'

/**
 * Contrast as a repair, not only as a verdict.
 *
 * `theme-contrast.test.ts` proves the shipped palettes are readable. Nothing proved that about a
 * palette someone hands us — and the whole point of the design tools is that a palette can now
 * arrive from outside: an agent asked to "make it look like that site" produces brand colours,
 * which are chosen to look like a brand and not to clear 4.5:1 on a dashboard's inset grey.
 *
 * The sixty-four gallery palettes were not hand-picked either; each colour was walked in OKLCH
 * lightness until it cleared its floor against every surface it can sit on. This is that walk,
 * extracted and made callable, so a palette that comes in from an agent is solved the same way the
 * shipped ones were rather than merely graded. Hue and chroma are never touched: those are what
 * make a colour recognisably someone's blue, and lightness is what makes it readable.
 *
 * The matrix below is the same one `theme-contrast.test.ts` asserts, deliberately: a palette this
 * module says is fitted is a palette that would pass the suite.
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
  // WCAG 1.4.11. Our inputs have a transparent fill, so the border is the only thing that says
  // "this is a field" — and axe does not evaluate 1.4.11 automatically.
  ...SURFACES.map((background) => ({
    foreground: 'control-border',
    background,
    floor: AA_NON_TEXT,
  })),
]

/**
 * The order tokens are solved in.
 *
 * `accent-foreground` is last because its only surface is `accent`, which may itself have just
 * moved: solving it first would fit it to a colour that no longer exists. The three surfaces are
 * absent from this list on purpose — they are the design, and a fit that darkened someone's chosen
 * background to rescue a label would have solved the wrong problem.
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

/** The failing half of `contrastChecks`, which is the half worth putting in a tool result. */
export function contrastFailures(tokens: Readonly<Record<string, string>>): ContrastCheck[] {
  return contrastChecks(tokens).filter((check) => !check.passes)
}

/**
 * Lightness candidates, nearest first.
 *
 * Nearest-first is what makes the result a nudge rather than a re-authoring: the first lightness
 * that satisfies every rule is by construction the smallest move that does. Both directions are
 * offered because which one helps depends on the surface — on a light theme a label darkens, on a
 * dark one it lightens, and a token can sit on both a light and a dark surface at once.
 */
const STEP = 0.0025

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

/**
 * One candidate colour, guaranteed to be one a screen can show.
 *
 * Moving lightness at fixed chroma walks OUT of the sRGB gamut — a vivid teal that is fine at
 * L 0.72 is not at L 0.60 — and an out-of-gamut value is where the ratio this module computes and
 * the ratio a browser paints come apart. Clamping chroma per candidate keeps the walk inside the
 * space the maths is valid in, so "fitted" means the screen agrees.
 */
function candidateAt(lightness: number, chroma: number, hue: number): string {
  return formatInGamut(lightness, chroma, hue)
}

/**
 * How good a candidate is: how many of its rules it FAILS, then how close the worst one is.
 *
 * Both halves are load-bearing, and the first was learned the hard way. Scoring only the worst
 * ratio — maximise the minimum — is the obvious thing and it is wrong when no candidate can win:
 * dragging a rule that was passing at 6.1:1 down to 2.3:1 raises the minimum, so the walk counts it
 * an improvement and writes it. On a palette with incompatible surfaces that repaired nothing,
 * broke a pair that had been fine, and reported eight moves as fixes. Counting the failures first
 * makes "fewer things are broken" beat "the worst thing is slightly less broken", which is the
 * order a person reading the board would choose.
 *
 * A rule whose SURFACE cannot be read as a colour is skipped rather than scored zero: there is no
 * lightness that fixes an unreadable background, and pretending otherwise is how a report starts
 * lying. A candidate that is not itself a colour scores nothing at all — without that check an
 * unreadable one skips every rule, scores "nothing failed", and gets certified as the solution.
 */
type Score = { readonly fails: number; readonly worst: number }

function score(
  value: string,
  rules: readonly ContrastRule[],
  tokens: Readonly<Record<string, string>>,
): Score | null {
  if (parseOklch(value) === null) return null
  let fails = 0
  let worst: number | null = null
  for (const rule of rules) {
    const ratio = contrastRatio(value, tokens[rule.background] ?? '')
    if (ratio === null) continue
    const margin = ratio / rule.floor
    if (margin < 1) fails += 1
    worst = worst === null ? margin : Math.min(worst, margin)
  }
  return worst === null ? null : { fails, worst }
}

/** Fewer failures wins; a tie goes to the one whose worst pair has the most room. */
function better(candidate: Score, incumbent: Score): boolean {
  return candidate.fails !== incumbent.fails
    ? candidate.fails < incumbent.fails
    : candidate.worst > incumbent.worst
}

function describe(
  token: string,
  rules: readonly ContrastRule[],
  tokens: Readonly<Record<string, string>>,
): string {
  let worst: { rule: ContrastRule; ratio: number } | null = null
  for (const rule of rules) {
    const ratio = contrastRatio(tokens[token] ?? '', tokens[rule.background] ?? '')
    if (ratio === null) continue
    if (worst === null || ratio / rule.floor < worst.ratio / worst.rule.floor) {
      worst = { rule, ratio }
    }
  }
  if (worst === null) return `${token} could not be read as a colour`
  return (
    `${token} on ${worst.rule.background} was ${worst.ratio.toFixed(2)}:1, ` +
    `below ${String(worst.rule.floor)}:1`
  )
}

/** A token the walk cannot help, and the reason, so the caller is told rather than reassured. */
export type Unfittable = { readonly token: string; readonly why: string }

export type FitResult = {
  tokens: Record<string, string>
  adjustments: Adjustment[]
  unfittable: Unfittable[]
}

/**
 * One walk over every fittable token.
 *
 * Separate from `fitPalette` because a single pass is not guaranteed to be the last word: moving a
 * token can change what the next one is solved against, and near black a fixed hue's luminance is
 * flat enough to be non-monotonic in lightness, so a second look can find a better near miss than
 * the first. `fitPalette` runs this to a fixed point; this function is just the pass.
 */
function fitOnce(tokens: Readonly<Record<string, string>>): FitResult {
  const fitted: Record<string, string> = { ...tokens }
  const adjustments: Adjustment[] = []
  const unfittable: Unfittable[] = []

  // Anything the matrix names, on either side, has to be a colour before any of this means
  // something. A surface that is not one takes every rule above it out of the walk — which used
  // to come back as "nothing needed adjusting" beside eight failures nobody could act on.
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
    if (rules.length === 0) continue
    const before = score(fitted[token] ?? '', rules, fitted)
    if (before === null || before.fails === 0) continue

    const current = parseOklch(fitted[token] ?? '')
    if (current === null) continue

    const reason = describe(token, rules, fitted)
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

    // A near miss is worth applying — an unreadable pair pulled from 2.9:1 to 4.3:1 is better for
    // the person reading the board than one left where it was. A miss that improves NOTHING is
    // not: it would be a diff in someone's git repository in exchange for the same colour.
    const chosen = solved ?? (best !== null && better(best.score, before) ? best.value : undefined)
    if (chosen === undefined) {
      unfittable.push({ token, why: `${reason}, and no lightness of that hue clears it` })
      continue
    }

    const from = fitted[token] as string
    adjustments.push({
      token,
      from,
      to: chosen,
      fromHex: toHex(from),
      toHex: toHex(chosen),
      reason,
      resolved: solved !== null,
      ...((parseOklch(chosen)?.c ?? 0) < current.c - 0.0005 ? { chromaReduced: true } : {}),
    })
    fitted[token] = chosen
  }

  return { tokens: fitted, adjustments, unfittable }
}

/**
 * Walk each failing token's lightness until the whole matrix passes.
 *
 * Only tokens that FAIL are touched, so a palette that already reads well comes back identical and
 * a preset is never quietly rewritten — measured across all 150 shipped preset-and-scheme pairs,
 * this fires zero times.
 *
 * Run to a fixed point rather than once, because a single pass is not always its own answer: on an
 * unsolvable palette a second look can improve a near miss the first one settled for, and a
 * function whose output is not a valid input to itself would mean calling `set_theme` twice with
 * the same arguments produced two different themes. Three rounds is a cap, not a target — the
 * palettes that move at all settle in two.
 *
 * Two situations produce no walk, and both are reported rather than passed over: a token that is
 * not `oklch(L C H)`, which has no lightness to move, and a token whose every surface is
 * unreadable, which has nothing to be solved against. Silence on either read as "nothing needed
 * adjusting" next to a failure list, which is the report saying the opposite of the truth.
 */
export function fitPalette(tokens: Readonly<Record<string, string>>): FitResult {
  let fitted: Record<string, string> = { ...tokens }
  let unfittable: Unfittable[] = []
  // Keyed by token so a colour moved twice is reported once, from where it started to where it
  // ended up. A caller wants to know what happened to their blue, not the route it took.
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
      const shrank = (parseOklch(adjustment.to)?.c ?? 0) < (parseOklch(first.from)?.c ?? 0) - 0.0005
      moved.set(adjustment.token, {
        ...adjustment,
        from: first.from,
        fromHex: first.fromHex,
        reason: first.reason,
        ...(shrank ? { chromaReduced: true } : {}),
      })
    }
  }

  return { tokens: fitted, adjustments: [...moved.values()], unfittable }
}
