/**
 * Named theme presets: colours for both schemes plus shape/type tokens, resolved by `resolveTokens`
 * as shape defaults < colour defaults < preset < user `cssVars`.
 *
 * Must not import `theme-tokens.ts` (it imports this module; a value cycle is a load-order bug).
 * Every colour is `oklch(L C H)` because `contrast.ts` parses nothing else.
 */

import { GALLERY_PRESETS } from './theme-gallery.ts'

export type PresetTokens = Readonly<Record<string, string>>

export type ThemePreset = {
  readonly id: string
  readonly label: string
  readonly blurb: string
  readonly light: PresetTokens
  readonly dark: PresetTokens
  /** Scheme-independent: shape, elevation and type. */
  readonly shape: PresetTokens
  /**
   * A `theme-backgrounds` id applied once when the preset is picked; it lives on `theme.surface`,
   * not in the token merge.
   */
  readonly background?: string
}

/**
 * Non-colour tokens a preset may set; `SHAPE_DEFAULTS` fills any it omits so nothing leaks
 * between presets.
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
  'stat-bg',
  'stat-padding',
  'stat-align',
] as const

export type ShapeToken = (typeof SHAPE_TOKENS)[number]

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
  // A preset that paints a solid accent block must flip this to accent-foreground.
  'link-color': 'var(--nh-accent)',
  'link-bg-hover': 'color-mix(in oklch,var(--nh-accent) 22%,transparent)',
  'link-border': 'none',
  'link-shadow': 'none',
  'link-weight': '600',
  'max-width': '1600px',
  // Readings sit bare by default; a preset, the design panel or a widget can box and centre them.
  'stat-bg': 'transparent',
  'stat-padding': '0',
  'stat-align': 'start',
}

// Empty colour maps fall through to LIGHT_DEFAULTS/DARK_DEFAULTS, so this cannot drift from them.
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

const ERA_8BIT_PRESET: ThemePreset = {
  id: '8bit',
  label: '8-bit',
  blurb:
    'A 1989 DMG in one hue \u2014 four shades of olive on a pea-soup LCD, sprites offset on a hard shadow.',
  background: 'dmg-matrix',
  light: {
    background: 'oklch(0.84 0.12 122)',
    foreground: 'oklch(0.27 0.06 145)',
    surface: 'oklch(0.88 0.11 122)',
    'surface-foreground': 'oklch(0.27 0.06 145)',
    muted: 'oklch(0.92 0.085 120)',
    'muted-foreground': 'oklch(0.42 0.075 143)',
    border: 'oklch(0.45 0.08 143)',
    'control-border': 'oklch(0.40 0.075 145)',
    accent: 'oklch(0.38 0.09 145)',
    'accent-foreground': 'oklch(0.92 0.085 120)',
    ok: 'oklch(0.42 0.095 155)',
    warn: 'oklch(0.44 0.10 100)',
    bad: 'oklch(0.42 0.11 60)',
  },
  dark: {
    background: 'oklch(0.20 0.035 145)',
    foreground: 'oklch(0.88 0.11 122)',
    surface: 'oklch(0.25 0.04 145)',
    'surface-foreground': 'oklch(0.88 0.11 122)',
    muted: 'oklch(0.31 0.045 145)',
    'muted-foreground': 'oklch(0.75 0.12 125)',
    border: 'oklch(0.45 0.07 143)',
    'control-border': 'oklch(0.58 0.09 140)',
    accent: 'oklch(0.82 0.145 122)',
    'accent-foreground': 'oklch(0.20 0.035 145)',
    ok: 'oklch(0.80 0.13 152)',
    warn: 'oklch(0.86 0.15 105)',
    bad: 'oklch(0.72 0.13 55)',
  },
  shape: {
    radius: '0px',
    'radius-control': '0px',
    'border-width': '2px',
    shadow: '4px 4px 0 0 var(--nh-border)',
    'font-sans': 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace',
    'title-transform': 'uppercase',
    'title-tracking': '0.18em',
    'title-size': '0.72rem',
    'link-bg': 'var(--nh-accent)',
    'link-color': 'var(--nh-accent-foreground)',
    'link-bg-hover': 'color-mix(in oklch, var(--nh-accent) 80%, var(--nh-foreground))',
    'link-border': '2px solid var(--nh-border)',
    'link-shadow': '3px 3px 0 0 var(--nh-border)',
    'link-weight': '700',
    'max-width': '1400px',
  },
}

const ERA_16BIT_PRESET: ThemePreset = {
  id: '16bit',
  label: '16-bit',
  blurb:
    'The 16-bit console years \u2014 a lavender-grey deck, purple accents and the four coloured buttons as status.',
  background: 'snes-weave',
  light: {
    background: 'oklch(0.94 0.012 300)',
    foreground: 'oklch(0.25 0.03 300)',
    surface: 'oklch(0.985 0.004 300)',
    'surface-foreground': 'oklch(0.25 0.03 300)',
    muted: 'oklch(0.90 0.02 300)',
    'muted-foreground': 'oklch(0.44 0.03 300)',
    border: 'oklch(0.80 0.02 300)',
    'control-border': 'oklch(0.55 0.03 300)',
    accent: 'oklch(0.48 0.16 300)',
    'accent-foreground': 'oklch(0.99 0.002 300)',
    ok: 'oklch(0.48 0.13 150)',
    warn: 'oklch(0.49 0.115 72)',
    bad: 'oklch(0.50 0.19 27)',
  },
  dark: {
    background: 'oklch(0.19 0.04 295)',
    foreground: 'oklch(0.94 0.015 295)',
    surface: 'oklch(0.25 0.04 295)',
    'surface-foreground': 'oklch(0.94 0.015 295)',
    muted: 'oklch(0.32 0.045 295)',
    'muted-foreground': 'oklch(0.76 0.03 295)',
    border: 'oklch(0.40 0.04 295)',
    'control-border': 'oklch(0.62 0.05 295)',
    accent: 'oklch(0.72 0.14 300)',
    'accent-foreground': 'oklch(0.18 0.04 295)',
    ok: 'oklch(0.80 0.16 150)',
    warn: 'oklch(0.85 0.14 90)',
    bad: 'oklch(0.74 0.15 25)',
  },
  shape: {
    radius: '4px',
    'radius-control': '3px',
    'border-width': '2px',
    shadow:
      'inset 0 1px 0 0 oklch(1 0 0 / 0.35), 0 2px 0 0 oklch(0.55 0.05 300 / 0.28), 0 6px 14px -8px oklch(0.30 0.08 300 / 0.40)',
    'font-sans':
      'ui-sans-serif,"Helvetica Neue",Helvetica,system-ui,-apple-system,"Segoe UI",Arial,sans-serif',
    'font-mono': 'ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace',
    'title-transform': 'uppercase',
    'title-tracking': '0.1em',
    'title-size': '0.72rem',
    'link-bg': 'var(--nh-accent)',
    'link-color': 'var(--nh-accent-foreground)',
    'link-bg-hover': 'color-mix(in oklch,var(--nh-accent) 86%,var(--nh-accent-foreground))',
    'link-border': '2px solid color-mix(in oklch,var(--nh-accent) 66%,black)',
    'link-shadow':
      'inset 0 1px 0 0 oklch(1 0 0 / 0.38), inset 0 -1px 0 0 oklch(0 0 0 / 0.22), 0 2px 0 0 color-mix(in oklch,var(--nh-accent) 55%,black)',
    'link-weight': '700',
    'max-width': '1500px',
  },
}

const ERA_32BIT_PRESET: ThemePreset = {
  id: '32bit',
  label: '32-bit',
  blurb:
    'Neo Geo arcade cabinet: near-black ground, identity red burning against it, logo yellow for warnings, marquee lettering in Impact.',
  background: 'neogeo-scan',
  light: {
    background: 'oklch(0.945 0.014 85)',
    foreground: 'oklch(0.17 0.012 40)',
    surface: 'oklch(0.975 0.010 88)',
    'surface-foreground': 'oklch(0.17 0.012 40)',
    muted: 'oklch(0.895 0.018 82)',
    'muted-foreground': 'oklch(0.40 0.020 45)',
    border: 'oklch(0.20 0.012 40)',
    'control-border': 'oklch(0.35 0.015 40)',
    accent: 'oklch(0.45 0.195 28)',
    'accent-foreground': 'oklch(0.975 0.014 88)',
    ok: 'oklch(0.45 0.13 150)',
    warn: 'oklch(0.46 0.13 70)',
    bad: 'oklch(0.45 0.195 28)',
  },
  dark: {
    background: 'oklch(0.155 0.010 40)',
    foreground: 'oklch(0.94 0.012 85)',
    surface: 'oklch(0.205 0.012 40)',
    'surface-foreground': 'oklch(0.94 0.012 85)',
    muted: 'oklch(0.255 0.014 40)',
    'muted-foreground': 'oklch(0.74 0.020 70)',
    border: 'oklch(0.42 0.020 40)',
    'control-border': 'oklch(0.60 0.030 45)',
    accent: 'oklch(0.675 0.205 28)',
    'accent-foreground': 'oklch(0.14 0.010 40)',
    ok: 'oklch(0.80 0.19 145)',
    warn: 'oklch(0.86 0.18 95)',
    bad: 'oklch(0.675 0.205 28)',
  },
  shape: {
    radius: '0px',
    'radius-control': '0px',
    'border-width': '3px',
    shadow: '5px 5px 0 0 var(--nh-border)',
    'font-sans':
      'Impact, "Arial Black", "Helvetica Neue", Helvetica, Arial, ui-sans-serif, system-ui, sans-serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace',
    'title-transform': 'uppercase',
    'title-tracking': '0.04em',
    'title-size': '0.88rem',
    'link-bg': 'var(--nh-accent)',
    'link-color': 'var(--nh-accent-foreground)',
    'link-bg-hover': 'color-mix(in oklch, var(--nh-accent) 78%, var(--nh-warn))',
    'link-border': '3px solid var(--nh-border)',
    'link-shadow': '4px 4px 0 0 var(--nh-border)',
    'link-weight': '700',
    'max-width': '1400px',
  },
}

const ERA_64BIT_PRESET: ThemePreset = {
  id: '64bit',
  label: '64-bit',
  blurb:
    'The first 3D generation \u2014 translucent teal plastic and fogged charcoal-blue, where the hard edges finally started to blur.',
  background: 'ps1-haze',
  light: {
    background: 'oklch(0.94 0.008 300)',
    foreground: 'oklch(0.28 0.02 290)',
    surface: 'oklch(0.975 0.006 300)',
    'surface-foreground': 'oklch(0.28 0.02 290)',
    muted: 'oklch(0.90 0.012 300)',
    'muted-foreground': 'oklch(0.44 0.02 290)',
    border: 'oklch(0.85 0.015 300)',
    'control-border': 'oklch(0.55 0.03 290)',
    accent: 'oklch(0.47 0.095 200)',
    'accent-foreground': 'oklch(0.99 0.005 200)',
    ok: 'oklch(0.47 0.095 165)',
    warn: 'oklch(0.49 0.105 65)',
    bad: 'oklch(0.48 0.16 355)',
  },
  dark: {
    background: 'oklch(0.22 0.02 265)',
    foreground: 'oklch(0.93 0.01 265)',
    surface: 'oklch(0.27 0.022 265)',
    'surface-foreground': 'oklch(0.93 0.01 265)',
    muted: 'oklch(0.33 0.025 265)',
    'muted-foreground': 'oklch(0.76 0.02 265)',
    border: 'oklch(0.38 0.025 265)',
    'control-border': 'oklch(0.62 0.03 265)',
    accent: 'oklch(0.80 0.12 195)',
    'accent-foreground': 'oklch(0.20 0.03 220)',
    ok: 'oklch(0.80 0.13 160)',
    warn: 'oklch(0.85 0.13 80)',
    bad: 'oklch(0.75 0.14 5)',
  },
  shape: {
    radius: '12px',
    'radius-control': '10px',
    'border-width': '1px',
    shadow:
      '0 1px 2px 0 color-mix(in oklab, var(--nh-border) 55%, transparent), 0 10px 28px -12px color-mix(in oklab, var(--nh-accent) 30%, transparent)',
    'font-sans':
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
    'font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace',
    'title-transform': 'none',
    'title-tracking': '0.02em',
    'title-size': '0.82rem',
    'link-bg': 'color-mix(in oklab, var(--nh-accent) 16%, transparent)',
    'link-color': 'var(--nh-accent)',
    'link-bg-hover': 'color-mix(in oklab, var(--nh-accent) 30%, transparent)',
    'link-border': '1px solid color-mix(in oklab, var(--nh-accent) 45%, transparent)',
    'link-shadow':
      '0 0 0 1px color-mix(in oklab, var(--nh-accent) 12%, transparent), 0 6px 18px -8px color-mix(in oklab, var(--nh-accent) 60%, transparent)',
    'link-weight': '600',
    'max-width': '1600px',
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
  ERA_8BIT_PRESET,
  ERA_16BIT_PRESET,
  ERA_32BIT_PRESET,
  ERA_64BIT_PRESET,
]

/**
 * Curated presets plus the generated gallery; kept separate above so the design panel can present
 * them differently.
 */
export const ALL_PRESETS: readonly ThemePreset[] = [...THEME_PRESETS, ...GALLERY_PRESETS]

export function presetById(id: string): ThemePreset | undefined {
  return ALL_PRESETS.find((preset) => preset.id === id)
}
