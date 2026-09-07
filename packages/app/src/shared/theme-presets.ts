/**
 * Named theme presets: a whole look in one identifier.
 *
 * `theme.preset` has existed in the schema since v1 and resolved to nothing — every install got
 * `LIGHT_DEFAULTS`/`DARK_DEFAULTS` and no way to ask for another look. This is the table that makes
 * the field mean something. A preset supplies a complete colour set for BOTH schemes plus the
 * non-colour tokens that carry as much of a theme's character as its hue does: corner radius,
 * border weight, elevation, the type stack, and how a bookmark button is painted.
 *
 * Precedence, resolved in `resolveTokens`: shape defaults, colour defaults, the preset, then the
 * user's own `cssVars`. So picking a preset never traps anyone — every token it sets stays
 * overridable from the design panel, and clearing an override falls back to the preset rather than
 * to the stock grey.
 *
 * This module deliberately imports nothing from `theme-tokens.ts`: that module imports THIS one to
 * resolve a preset, and a value-level cycle between them would be a real load-order bug rather
 * than a style opinion.
 *
 * Every colour here is `oklch(L C H)` because `contrast.ts` parses nothing else — a hex value
 * would make `contrastRatio` return null, and `theme-contrast.test.ts` treats null as a failure.
 * That is what keeps a pretty palette from shipping unreadable: see the preset matrix in that test.
 */

export type PresetTokens = Readonly<Record<string, string>>

export type ThemePreset = {
  readonly id: string
  readonly label: string
  readonly blurb: string
  readonly light: PresetTokens
  readonly dark: PresetTokens
  /** Scheme-independent: shape, elevation and type. */
  readonly shape: PresetTokens
}

/**
 * The non-colour tokens every preset may set.
 *
 * Listed as a contract for the same reason `THEME_TOKENS` is: the stylesheet consumes these by
 * name, and a preset that forgets one would silently inherit another preset's value at runtime
 * were it not for `SHAPE_DEFAULTS` filling the gap first.
 */
export const SHAPE_TOKENS = [
  'radius',
  'radius-control',
  'border-width',
  'shadow',
  'font-sans',
  'font-mono',
  'title-transform',
  'title-tracking',
  'title-size',
  'link-bg',
  'link-color',
  'link-bg-hover',
  'link-border',
  'link-shadow',
  'link-weight',
  'max-width',
] as const

export type ShapeToken = (typeof SHAPE_TOKENS)[number]

/** The shape of the board exactly as it looked before presets existed. */
export const SHAPE_DEFAULTS: Record<ShapeToken, string> = {
  radius: '12px',
  'radius-control': '8px',
  'border-width': '1px',
  shadow: 'none',
  'font-sans': 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
  'font-mono': 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
  'title-transform': 'uppercase',
  'title-tracking': '0.01em',
  'title-size': '0.8125rem',
  'link-bg': 'color-mix(in oklch,var(--nh-accent) 8%,transparent)',
  // A translucent fill keeps the accent readable as text. A preset that paints a SOLID accent
  // block must flip this to accent-foreground, or the label is the same colour as the button.
  'link-color': 'var(--nh-accent)',
  'link-bg-hover': 'color-mix(in oklch,var(--nh-accent) 22%,transparent)',
  'link-border': 'none',
  'link-shadow': 'none',
  'link-weight': '600',
  'max-width': '1600px',
}

/**
 * The stock look, named so it can be chosen back after trying another.
 *
 * Its colour maps are intentionally empty: leaving them out means "whatever LIGHT_DEFAULTS and
 * DARK_DEFAULTS say", so the default preset cannot drift away from the defaults it is named for.
 */
const DEFAULT_PRESET: ThemePreset = {
  id: 'default',
  label: 'Default',
  blurb: 'The stock neutral palette — quiet greys with a blue accent.',
  light: {},
  dark: {},
  shape: {},
}

const NORD_PRESET: ThemePreset = {
  id: 'nord',
  label: 'Nord',
  blurb:
    'Calm arctic slate \u2014 cool blue-grey neutrals and a desaturated frost-blue accent, built to sit on a wall all day.',
  light: {
    background: 'oklch(0.965 0.010 250)',
    foreground: 'oklch(0.30 0.020 255)',
    surface: 'oklch(0.99 0.008 250)',
    'surface-foreground': 'oklch(0.30 0.020 255)',
    muted: 'oklch(0.935 0.014 250)',
    'muted-foreground': 'oklch(0.46 0.018 255)',
    border: 'oklch(0.88 0.012 250)',
    'control-border': 'oklch(0.60 0.020 255)',
    accent: 'oklch(0.50 0.09 245)',
    'accent-foreground': 'oklch(0.99 0.005 250)',
    ok: 'oklch(0.50 0.10 155)',
    warn: 'oklch(0.52 0.105 72)',
    bad: 'oklch(0.50 0.15 25)',
  },
  dark: {
    background: 'oklch(0.22 0.014 255)',
    foreground: 'oklch(0.92 0.010 250)',
    surface: 'oklch(0.26 0.014 255)',
    'surface-foreground': 'oklch(0.92 0.010 250)',
    muted: 'oklch(0.31 0.016 255)',
    'muted-foreground': 'oklch(0.76 0.014 250)',
    border: 'oklch(0.36 0.016 255)',
    'control-border': 'oklch(0.62 0.020 255)',
    accent: 'oklch(0.75 0.09 240)',
    'accent-foreground': 'oklch(0.20 0.015 255)',
    ok: 'oklch(0.80 0.11 155)',
    warn: 'oklch(0.83 0.11 80)',
    bad: 'oklch(0.72 0.13 20)',
  },
  shape: {
    radius: '13px',
    'radius-control': '9px',
    'border-width': '1px',
    shadow:
      '0 1px 2px color-mix(in oklch, var(--nh-foreground) 6%, transparent), 0 6px 18px -8px color-mix(in oklch, var(--nh-foreground) 12%, transparent)',
    'font-sans':
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'title-transform': 'none',
    'title-tracking': '0.015em',
    'title-size': '0.8125rem',
    'link-bg': 'color-mix(in oklch, var(--nh-accent) 10%, transparent)',
    'link-border': '1px solid color-mix(in oklch, var(--nh-accent) 28%, transparent)',
    'link-shadow': 'none',
    'link-weight': '500',
  },
}

const TERMINAL_PRESET: ThemePreset = {
  id: 'terminal',
  label: 'Terminal',
  blurb: 'Phosphor CRT: near-black ground, glowing green ink, zero radius, all monospace.',
  light: {
    background: 'oklch(0.975 0.008 140)',
    foreground: 'oklch(0.25 0.03 150)',
    surface: 'oklch(0.995 0.004 140)',
    'surface-foreground': 'oklch(0.25 0.03 150)',
    muted: 'oklch(0.94 0.015 145)',
    'muted-foreground': 'oklch(0.45 0.04 150)',
    border: 'oklch(0.86 0.02 145)',
    'control-border': 'oklch(0.55 0.06 150)',
    accent: 'oklch(0.45 0.13 152)',
    'accent-foreground': 'oklch(0.98 0.01 140)',
    ok: 'oklch(0.48 0.13 150)',
    warn: 'oklch(0.515 0.12 72)',
    bad: 'oklch(0.5 0.19 27)',
  },
  dark: {
    background: 'oklch(0.15 0.012 150)',
    foreground: 'oklch(0.9 0.06 145)',
    surface: 'oklch(0.19 0.016 150)',
    'surface-foreground': 'oklch(0.9 0.06 145)',
    muted: 'oklch(0.25 0.02 150)',
    'muted-foreground': 'oklch(0.72 0.06 148)',
    border: 'oklch(0.32 0.03 150)',
    'control-border': 'oklch(0.55 0.07 150)',
    accent: 'oklch(0.82 0.19 145)',
    'accent-foreground': 'oklch(0.15 0.012 150)',
    ok: 'oklch(0.8 0.17 148)',
    warn: 'oklch(0.83 0.15 80)',
    bad: 'oklch(0.68 0.19 25)',
  },
  shape: {
    radius: '0px',
    'radius-control': '0px',
    'border-width': '1px',
    shadow: 'none',
    'font-sans': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'title-transform': 'uppercase',
    'title-tracking': '0.14em',
    'title-size': '0.7rem',
    'link-bg': 'transparent',
    'link-border': '1px solid var(--nh-accent)',
    'link-shadow':
      '0 0 14px color-mix(in oklch, var(--nh-accent) 32%, transparent), inset 0 0 10px color-mix(in oklch, var(--nh-accent) 12%, transparent)',
    'link-weight': '500',
  },
}

const GLASS_PRESET: ThemePreset = {
  id: 'glass',
  label: 'Glass',
  blurb: 'Frosted panels floating on a deep blue-violet ground, lit by a luminous azure.',
  light: {
    background: 'oklch(0.93 0.022 278)',
    foreground: 'oklch(0.26 0.05 278)',
    surface: 'oklch(0.985 0.008 278)',
    'surface-foreground': 'oklch(0.26 0.05 278)',
    muted: 'oklch(0.955 0.016 278)',
    'muted-foreground': 'oklch(0.47 0.04 278)',
    border: 'oklch(0.88 0.02 278)',
    'control-border': 'oklch(0.585 0.055 278)',
    accent: 'oklch(0.495 0.155 245)',
    'accent-foreground': 'oklch(0.99 0.005 245)',
    ok: 'oklch(0.485 0.125 155)',
    warn: 'oklch(0.505 0.125 62)',
    bad: 'oklch(0.51 0.19 25)',
  },
  dark: {
    background: 'oklch(0.19 0.04 275)',
    foreground: 'oklch(0.96 0.012 275)',
    surface: 'oklch(0.27 0.04 275)',
    'surface-foreground': 'oklch(0.96 0.012 275)',
    muted: 'oklch(0.33 0.038 275)',
    'muted-foreground': 'oklch(0.80 0.03 275)',
    border: 'oklch(0.42 0.04 275)',
    'control-border': 'oklch(0.62 0.05 275)',
    accent: 'oklch(0.78 0.13 235)',
    'accent-foreground': 'oklch(0.20 0.05 245)',
    ok: 'oklch(0.82 0.15 155)',
    warn: 'oklch(0.85 0.14 80)',
    bad: 'oklch(0.74 0.16 20)',
  },
  shape: {
    radius: '20px',
    'radius-control': '14px',
    'border-width': '1px',
    shadow:
      '0 1px 0 color-mix(in oklch, white 45%, transparent) inset, 0 2px 6px color-mix(in oklch, var(--nh-background) 55%, transparent), 0 22px 48px -18px color-mix(in oklch, var(--nh-background) 85%, transparent)',
    'font-sans':
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'title-transform': 'none',
    'title-tracking': '0.005em',
    'title-size': '0.82rem',
    'link-bg': 'color-mix(in oklch, var(--nh-accent) 14%, transparent)',
    'link-border': '1px solid color-mix(in oklch, var(--nh-accent) 45%, transparent)',
    'link-shadow':
      '0 0 22px color-mix(in oklch, var(--nh-accent) 38%, transparent), 0 1px 0 color-mix(in oklch, white 35%, transparent) inset',
    'link-weight': '600',
  },
}

const BRUTALIST_PRESET: ThemePreset = {
  id: 'brutalist',
  label: 'Brutalist',
  blurb:
    'Bare white paper, black ink and one screaming red: zero radius, 3px rules, hard offset shadows.',
  light: {
    background: 'oklch(0.97 0 0)',
    foreground: 'oklch(0.14 0 0)',
    surface: 'oklch(1 0 0)',
    'surface-foreground': 'oklch(0.14 0 0)',
    muted: 'oklch(0.925 0 0)',
    'muted-foreground': 'oklch(0.42 0 0)',
    border: 'oklch(0.14 0 0)',
    'control-border': 'oklch(0.14 0 0)',
    accent: 'oklch(0.51 0.23 27)',
    'accent-foreground': 'oklch(1 0 0)',
    ok: 'oklch(0.48 0.145 145)',
    warn: 'oklch(0.50 0.125 66)',
    bad: 'oklch(0.47 0.20 22)',
  },
  dark: {
    background: 'oklch(0.145 0 0)',
    foreground: 'oklch(0.98 0 0)',
    surface: 'oklch(0.19 0 0)',
    'surface-foreground': 'oklch(0.98 0 0)',
    muted: 'oklch(0.26 0 0)',
    'muted-foreground': 'oklch(0.74 0 0)',
    border: 'oklch(0.98 0 0)',
    'control-border': 'oklch(0.82 0 0)',
    accent: 'oklch(0.68 0.21 27)',
    'accent-foreground': 'oklch(0.145 0 0)',
    ok: 'oklch(0.80 0.19 145)',
    warn: 'oklch(0.83 0.16 78)',
    bad: 'oklch(0.70 0.20 22)',
  },
  shape: {
    radius: '0px',
    'radius-control': '0px',
    'border-width': '3px',
    shadow: '6px 6px 0 0 var(--nh-border)',
    'font-sans':
      '"Helvetica Neue", Helvetica, Arial, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'title-transform': 'uppercase',
    'title-tracking': '-0.01em',
    'title-size': '0.9rem',
    'link-bg': 'var(--nh-accent)',
    'link-color': 'var(--nh-accent-foreground)',
    'link-bg-hover': 'color-mix(in oklch, var(--nh-accent) 82%, var(--nh-foreground))',
    'link-border': '3px solid var(--nh-border)',
    'link-shadow': '5px 5px 0 0 var(--nh-border)',
    'link-weight': '800',
  },
}

const AMBER_PRESET: ThemePreset = {
  id: 'amber',
  label: 'Amber',
  blurb:
    'Warm reading light \u2014 cream paper and espresso, set in a serif, for a screen you glance at after dark.',
  light: {
    background: 'oklch(0.965 0.020 84)',
    foreground: 'oklch(0.28 0.030 60)',
    surface: 'oklch(0.985 0.012 86)',
    'surface-foreground': 'oklch(0.28 0.030 60)',
    muted: 'oklch(0.935 0.026 82)',
    'muted-foreground': 'oklch(0.45 0.035 65)',
    border: 'oklch(0.88 0.030 80)',
    'control-border': 'oklch(0.56 0.045 70)',
    accent: 'oklch(0.52 0.14 55)',
    'accent-foreground': 'oklch(0.98 0.012 85)',
    ok: 'oklch(0.50 0.11 145)',
    warn: 'oklch(0.525 0.125 68)',
    bad: 'oklch(0.50 0.17 28)',
  },
  dark: {
    background: 'oklch(0.19 0.018 70)',
    foreground: 'oklch(0.92 0.022 85)',
    surface: 'oklch(0.235 0.020 72)',
    'surface-foreground': 'oklch(0.92 0.022 85)',
    muted: 'oklch(0.285 0.022 74)',
    'muted-foreground': 'oklch(0.76 0.028 82)',
    border: 'oklch(0.34 0.024 75)',
    'control-border': 'oklch(0.60 0.040 78)',
    accent: 'oklch(0.78 0.13 65)',
    'accent-foreground': 'oklch(0.20 0.030 60)',
    ok: 'oklch(0.80 0.14 150)',
    warn: 'oklch(0.83 0.14 80)',
    bad: 'oklch(0.72 0.15 30)',
  },
  shape: {
    radius: '16px',
    'radius-control': '10px',
    'border-width': '1px',
    shadow:
      '0 1px 2px color-mix(in oklch, var(--nh-foreground) 6%, transparent), 0 10px 28px -14px color-mix(in oklch, var(--nh-accent) 30%, transparent)',
    'font-sans': 'ui-serif, Georgia, "Iowan Old Style", Palatino, serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'title-transform': 'none',
    'title-tracking': '0',
    'title-size': '0.9375rem',
    'link-bg': 'color-mix(in oklch, var(--nh-accent) 12%, transparent)',
    'link-border': '1px solid color-mix(in oklch, var(--nh-accent) 28%, transparent)',
    'link-shadow': 'none',
    'link-weight': '600',
  },
}

const SYNTHWAVE_PRESET: ThemePreset = {
  id: 'synthwave',
  label: 'Synthwave',
  blurb:
    "Neon dusk: deep indigo ground, hot magenta accent and cyan status, with a geometric sans (Helvetica Neue/Arial) because the era's grids and chrome type were grotesque, not typewriter.",
  light: {
    background: 'oklch(0.968 0.014 315)',
    foreground: 'oklch(0.26 0.06 300)',
    surface: 'oklch(0.992 0.008 320)',
    'surface-foreground': 'oklch(0.26 0.06 300)',
    muted: 'oklch(0.938 0.022 312)',
    'muted-foreground': 'oklch(0.46 0.05 305)',
    border: 'oklch(0.87 0.03 310)',
    'control-border': 'oklch(0.56 0.06 305)',
    accent: 'oklch(0.52 0.22 350)',
    'accent-foreground': 'oklch(0.99 0.01 340)',
    ok: 'oklch(0.495 0.1 197)',
    warn: 'oklch(0.515 0.12 62)',
    bad: 'oklch(0.53 0.21 15)',
  },
  dark: {
    background: 'oklch(0.17 0.045 285)',
    foreground: 'oklch(0.95 0.02 300)',
    surface: 'oklch(0.225 0.055 288)',
    'surface-foreground': 'oklch(0.95 0.02 300)',
    muted: 'oklch(0.29 0.06 290)',
    'muted-foreground': 'oklch(0.76 0.045 300)',
    border: 'oklch(0.36 0.08 295)',
    'control-border': 'oklch(0.62 0.12 300)',
    accent: 'oklch(0.72 0.21 350)',
    'accent-foreground': 'oklch(0.16 0.05 290)',
    ok: 'oklch(0.82 0.14 190)',
    warn: 'oklch(0.84 0.15 78)',
    bad: 'oklch(0.7 0.2 18)',
  },
  shape: {
    radius: '10px',
    'radius-control': '8px',
    'border-width': '1px',
    shadow:
      '0 0 0 1px color-mix(in oklch, var(--nh-accent) 14%, transparent), 0 10px 40px -12px color-mix(in oklch, var(--nh-accent) 30%, transparent), 0 2px 10px color-mix(in oklch, var(--nh-accent) 10%, transparent)',
    'font-sans':
      '"Helvetica Neue", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    'title-transform': 'uppercase',
    'title-tracking': '0.16em',
    'title-size': '0.68rem',
    'link-bg': 'color-mix(in oklch, var(--nh-accent) 88%, transparent)',
    'link-color': 'var(--nh-accent-foreground)',
    'link-bg-hover': 'var(--nh-accent)',
    'link-border': '1px solid color-mix(in oklch, var(--nh-accent) 70%, transparent)',
    'link-shadow':
      '0 0 22px color-mix(in oklch, var(--nh-accent) 45%, transparent), 0 0 4px color-mix(in oklch, var(--nh-accent) 60%, transparent)',
    'link-weight': '700',
  },
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  DEFAULT_PRESET,
  NORD_PRESET,
  TERMINAL_PRESET,
  GLASS_PRESET,
  BRUTALIST_PRESET,
  AMBER_PRESET,
  SYNTHWAVE_PRESET,
]

export function presetById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id)
}
