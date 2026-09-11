import { SHAPE_TOKENS, type ShapeToken } from './theme-presets.ts'

/**
 * The closed sets of things a look can be made of.
 *
 * These lived inside `DesignPanel.tsx` for as long as the panel was the only way to change a
 * theme. It is not any more: the MCP surface offers the same choices to an agent, and `src/server`
 * may not import `src/web`. Two lists would be two chances to add a font to one and not the other,
 * so there is one, here, and both sides read it.
 *
 * Everything in this module is an ENUM of values the project authored. That is what lets the MCP
 * tools honour the rule that no agent writes CSS: a caller names `sans` or `narrow`, and the CSS
 * that reaches a stylesheet is a string from this file.
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

/**
 * The board's width cap.
 *
 * `inset` is the panel icon's margin in viewBox units — the reason the four icons read as a scale
 * rather than four unrelated glyphs. It lives with the value it draws so a fifth width cannot be
 * added with no picture of it.
 */
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

/**
 * Tile titles, as the two tokens that carry the treatment.
 *
 * Transform and tracking move together: uppercase without extra tracking is a wall, and tracked
 * sentence case is a ransom note. Storing them as one choice is what stops half of it being set.
 */
export type TitleCase = {
  readonly id: string
  readonly label: string
  readonly tokens: Readonly<Record<string, string>>
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

/**
 * The colour tokens, grouped the way someone thinks about a dashboard rather than alphabetically.
 *
 * The panel renders these as fieldsets and the MCP surface reports them under the same headings,
 * so "Tiles" means the same six tokens whether a person or an agent is reading.
 */
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

/**
 * The non-colour tokens, split by which reset button owns them.
 *
 * "Reset to the preset" under Shape used to name four tokens by hand and therefore missed the ones
 * only a finish sets — a button that says it undoes everything and undoes most of it is worse than
 * one that does nothing, because you believe it.
 *
 * So only the type half is authored, and the shape half is its complement: a token added to
 * `SHAPE_TOKENS` lands in a reset whatever anyone remembers to do. That is a property of the
 * construction, not something a test could catch — what `design-options.test.ts` can catch, and
 * does, is this list naming a token that no longer exists.
 */
/**
 * How a reading is drawn on a tile: bare, or boxed in the muted fill; left, or centred. Two
 * closed tables rather than free tokens, because these are the two questions the design panel
 * asks and the values are the whole answer.
 */
export type StatStyle = {
  readonly id: 'plain' | 'boxed'
  readonly label: string
  readonly tokens: Record<string, string>
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
  readonly tokens: Record<string, string>
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
 * The first family in a font stack, normalised.
 *
 * Whole stacks cannot be compared: a preset is free to append families ("Nord" adds Helvetica Neue
 * and Arial) and to write its list with spaces after the commas, so exact equality marked NOTHING
 * as active on six of the seven presets — the control looked broken because it never showed which
 * option you were on. The first family is what actually identifies the choice.
 */
export function firstFamily(stack: string | undefined): string {
  return (stack ?? '')
    .split(',')[0]
    ?.trim()
    .replaceAll('"', '')
    .replaceAll("'", '')
    .toLowerCase() as string
}

/** Which font stack a resolved `font-sans` is, or undefined for one no list here describes. */
export function fontStackOf(value: string | undefined): FontStack | undefined {
  return FONT_STACKS.find((stack) => firstFamily(stack.value) === firstFamily(value))
}

/** Which width cap a resolved `max-width` is. */
export function boardWidthOf(value: string | undefined): BoardWidth | undefined {
  return BOARD_WIDTHS.find((width) => width.value === (value ?? '1600px'))
}

/** Which title treatment a resolved `title-transform` is. Anything but uppercase is sentence. */
export function titleCaseOf(value: string | undefined): TitleCase {
  return (
    TITLE_CASES.find((entry) => entry.tokens['title-transform'] === value) ??
    (TITLE_CASES[1] as TitleCase)
  )
}
