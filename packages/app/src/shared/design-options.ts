import { SHAPE_DEFAULTS, SHAPE_TOKENS, type ShapeToken } from './theme-presets.ts'

/**
 * Closed option tables shared by the design panel and the MCP tools. A caller names an id, and the
 * CSS that reaches a stylesheet is always a string from this file: no agent writes CSS.
 */

export type FontStack = { readonly id: string; readonly label: string; readonly value: string }

export const FONT_STACKS: readonly FontStack[] = [
  {
    id: 'sans',
    label: 'Sans',
    value: 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
  },
  {
    id: 'grotesque',
    label: 'Grotesque',
    value: '"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif',
  },
  { id: 'mono', label: 'Mono', value: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace' },
  { id: 'serif', label: 'Serif', value: 'ui-serif,Georgia,"Iowan Old Style",Palatino,serif' },
]

/** Board width cap; `inset` is the panel icon's margin in viewBox units. */
export type BoardWidth = {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly inset: number
}

export const BOARD_WIDTHS: readonly BoardWidth[] = [
  { id: 'narrow', label: 'Narrow', value: '1200px', inset: 6 },
  { id: 'comfortable', label: 'Comfortable', value: '1600px', inset: 4 },
  { id: 'wide', label: 'Wide', value: '2000px', inset: 2 },
  { id: 'full', label: 'Full bleed', value: 'none', inset: 0 },
]

/** Title treatment as one choice: transform and tracking only work when set together. */
export type TitleCase = {
  readonly id: string
  readonly label: string
  readonly tokens: Readonly<Record<'title-transform' | 'title-tracking', string>>
}

export const TITLE_CASES: readonly TitleCase[] = [
  {
    id: 'uppercase',
    label: 'UPPERCASE',
    tokens: { 'title-transform': 'uppercase', 'title-tracking': '0.08em' },
  },
  {
    id: 'sentence',
    label: 'Sentence case',
    tokens: { 'title-transform': 'none', 'title-tracking': '0' },
  },
]

/** Colour tokens under the headings both the panel and the MCP surface use. */
export const COLOUR_GROUPS: readonly {
  readonly title: string
  readonly tokens: readonly { readonly name: string; readonly label: string }[]
}[] = [
  {
    title: 'Brand',
    tokens: [
      { name: 'accent', label: 'Accent' },
      { name: 'accent-foreground', label: 'On accent' },
    ],
  },
  {
    title: 'Page',
    tokens: [
      { name: 'background', label: 'Background' },
      { name: 'foreground', label: 'Text' },
    ],
  },
  {
    title: 'Tiles',
    tokens: [
      { name: 'surface', label: 'Tile' },
      { name: 'surface-foreground', label: 'Tile text' },
      { name: 'muted', label: 'Inset' },
      { name: 'muted-foreground', label: 'Label' },
      { name: 'border', label: 'Edge' },
      { name: 'control-border', label: 'Field edge' },
    ],
  },
  {
    title: 'Status',
    tokens: [
      { name: 'ok', label: 'Healthy' },
      { name: 'warn', label: 'Warning' },
      { name: 'bad', label: 'Failing' },
    ],
  },
]

/** How a reading is drawn on a tile: bare, or boxed in the muted fill. */
export type StatStyle = {
  readonly id: 'plain' | 'boxed'
  readonly label: string
  readonly tokens: Readonly<Record<'stat-bg' | 'stat-padding', string>>
}
export const STAT_STYLES: readonly StatStyle[] = [
  { id: 'plain', label: 'Plain', tokens: { 'stat-bg': 'transparent', 'stat-padding': '0' } },
  {
    id: 'boxed',
    label: 'Boxed',
    tokens: { 'stat-bg': 'var(--nh-muted)', 'stat-padding': '8px 10px' },
  },
]

export type StatAlign = {
  readonly id: 'start' | 'center'
  readonly label: string
  readonly tokens: Readonly<Record<'stat-align', string>>
}
export const STAT_ALIGNS: readonly StatAlign[] = [
  { id: 'start', label: 'Left', tokens: { 'stat-align': 'start' } },
  { id: 'center', label: 'Centred', tokens: { 'stat-align': 'center' } },
]

export function statStyleOf(bg: string | undefined): StatStyle {
  return (
    STAT_STYLES.find((entry) => entry.tokens['stat-bg'] === bg) ?? (STAT_STYLES[0] as StatStyle)
  )
}

export function statAlignOf(align: string | undefined): StatAlign {
  return (
    STAT_ALIGNS.find((entry) => entry.tokens['stat-align'] === align) ??
    (STAT_ALIGNS[0] as StatAlign)
  )
}

// Only the type half is authored; SHAPE_RESET_TOKENS is its complement, so a token added to
// SHAPE_TOKENS always lands in one of the two resets.
export const TYPE_RESET_TOKENS: readonly ShapeToken[] = [
  'stat-bg',
  'stat-padding',
  'stat-align',
  'font-sans',
  'font-mono',
  'title-transform',
  'title-tracking',
  'title-size',
]

export const SHAPE_RESET_TOKENS: readonly ShapeToken[] = SHAPE_TOKENS.filter(
  (token) => !TYPE_RESET_TOKENS.includes(token),
)

export function fontStackById(id: string): FontStack | undefined {
  return FONT_STACKS.find((stack) => stack.id === id)
}

export function boardWidthById(id: string): BoardWidth | undefined {
  return BOARD_WIDTHS.find((width) => width.id === id)
}

export function titleCaseById(id: string): TitleCase | undefined {
  return TITLE_CASES.find((entry) => entry.id === id)
}

/**
 * The first family in a font stack, normalised. Whole stacks cannot be compared: presets append
 * families and vary spacing after commas, so the first family is what identifies the choice.
 */
export function firstFamily(stack: string | undefined): string {
  const first = (stack ?? '').split(',')[0] ?? ''
  return first.trim().replaceAll('"', '').replaceAll("'", '').toLowerCase()
}

/** Which font stack a resolved `font-sans` is, or undefined for one no list here describes. */
export function fontStackOf(value: string | undefined): FontStack | undefined {
  return FONT_STACKS.find((stack) => firstFamily(stack.value) === firstFamily(value))
}

/** Which width cap a resolved `max-width` is. */
export function boardWidthOf(value: string | undefined): BoardWidth | undefined {
  return BOARD_WIDTHS.find((width) => width.value === (value ?? SHAPE_DEFAULTS['max-width']))
}

/** Which title treatment a resolved `title-transform` is. Anything but uppercase is sentence. */
export function titleCaseOf(value: string | undefined): TitleCase {
  return (
    TITLE_CASES.find((entry) => entry.tokens['title-transform'] === value) ??
    (TITLE_CASES[1] as TitleCase)
  )
}
