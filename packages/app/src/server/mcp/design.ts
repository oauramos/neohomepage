import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AppContext } from '../context.ts'
import { themeSchema, type Theme } from '../config/schema.ts'
import { env } from '../env.ts'
import { BACKGROUNDS_SUBDIR, isAssetId, listBackgrounds } from '../assets/store.ts'
import { formatInGamut, hexToOklch, parseOklch, toHex } from '../../shared/contrast.ts'
import {
  BOARD_WIDTHS,
  COLOUR_GROUPS,
  FONT_STACKS,
  SHAPE_RESET_TOKENS,
  TITLE_CASES,
  TYPE_RESET_TOKENS,
  boardWidthById,
  boardWidthOf,
  fontStackById,
  fontStackOf,
  titleCaseById,
  titleCaseOf,
} from '../../shared/design-options.ts'
import {
  contrastChecks,
  fitPalette,
  type Adjustment,
  type Unfittable,
} from '../../shared/palette-fit.ts'
import { BACKGROUNDS, GRADIENT_PREFIX, backgroundById } from '../../shared/theme-backgrounds.ts'
import { ALL_PRESETS, SHAPE_TOKENS, THEME_PRESETS, presetById } from '../../shared/theme-presets.ts'
import { finishOf } from '../../shared/theme-gallery.ts'
import {
  DARK_DEFAULTS,
  LIGHT_DEFAULTS,
  resolveTokens,
  THEME_TOKENS,
} from '../../shared/theme-tokens.ts'

/**
 * The design surface: everything the panel in the bottom-right corner can change, over MCP.
 *
 * The point is not parity for its own sake. It is that "make the board look like that site" is a
 * request a person can now make of an agent, and an agent has a browser: it can read a brand's
 * colours and hand them over. What it must not be able to hand over is CSS — so nothing here
 * accepts any. A caller names a preset, a token and a colour, a number in a range, or a member of
 * a closed set this project authored, and every string that reaches a stylesheet is one of ours.
 *
 * Three tools rather than one, and the split is by what a call costs. Reading the current look and
 * browsing the seventy-five presets are separate because the second is a catalogue and the first
 * is what you check before and after every write. Writing is ONE tool because a look is one
 * thought — "these colours, that shape, this background" — and splitting it would turn one
 * transaction, one generation and one republish into four of each.
 *
 * Two absences are deliberate and worth naming. There is no import-a-theme tool: `config/theme.json`
 * round-trips through the editor's own box because a person pasting their own file is exercising
 * their own judgement, while the same payload from an agent is arbitrary CSS text with a prompt
 * behind it. And there is no way to add a background image — an agent may choose one a person
 * already uploaded, by the content-addressed id the server gave it, and can never supply bytes or
 * name a URL.
 *
 * On spelling: this module says `colors` where the rest of the repository says `colour`. The names
 * in a tool schema are read by a model that will otherwise type the American form and — because
 * zod strips unknown keys rather than rejecting them — get a cheerful success and an unchanged
 * board. That failure is silent, so the schema takes the spelling the caller is likeliest to use
 * and the prose keeps ours.
 */

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

const SCHEMES = ['light', 'dark'] as const
type Scheme = (typeof SCHEMES)[number]
const BUCKETS = ['theme', ...SCHEMES] as const
type Bucket = (typeof BUCKETS)[number]

const COLOUR_TOKENS = new Set<string>(THEME_TOKENS)

/** Ids of the things a caller may name, built from the tables rather than restated beside them. */
const ids = (values: readonly { id: string }[]) =>
  values.map((value) => value.id) as [string, ...string[]]

/**
 * A colour, in either of the two forms it can honestly arrive in, re-emitted as one of ours.
 *
 * Hex is what a brand publishes and what a person reads off a screenshot; `oklch(L C H)` is what
 * this project stores, because `contrastRatio` parses nothing else and a hex in `cssVars` would
 * make every ratio in the design panel and in `theme-contrast.test.ts` come back null.
 *
 * Both forms are PARSED and then rebuilt, never passed through: `rgb(0,0,0)`, `red`, `var(--x)`
 * and `#fff;background:url(…)` all fail the same parse, and a value that survives it is re-emitted
 * by `formatInGamut` — so what lands in the file is a colour a screen can show, written by the one
 * function in the codebase that produces token text.
 */
function parseColour(value: string): string | null {
  const trimmed = value.trim()
  const parsed = parseOklch(trimmed) ?? parseOklch(hexToOklch(trimmed) ?? '')
  return parsed === null ? null : formatInGamut(parsed.l, parsed.c, parsed.h)
}

/** The reverse, for reporting: what the stored `surface.background` string means. */
function describeBackdrop(background: string | null) {
  if (background === null) return { kind: 'none' as const, id: null }
  if (background.startsWith(GRADIENT_PREFIX)) {
    const id = background.slice(GRADIENT_PREFIX.length)
    return { kind: 'gradient' as const, id, label: backgroundById(id)?.label ?? null }
  }
  return { kind: 'image' as const, id: background.slice(background.lastIndexOf('/') + 1) }
}

/** Both palettes as hex, which is the form a caller thinks in and the one it will send back. */
function paletteOf(theme: Theme, scheme: Scheme): Record<string, string | null> {
  const tokens = resolveTokens(theme, scheme)
  return Object.fromEntries(
    // Never the raw stored string: a value that is not a colour is reported as one that could not
    // be read, rather than echoed back into a model's context as text.
    THEME_TOKENS.map((token) => [token, toHex(tokens[token] ?? '')]),
  )
}

/** The contrast verdict, short enough to put in every result: the count, then only the failures. */
function contrastOf(theme: Theme, scheme: Scheme) {
  const checks = contrastChecks(resolveTokens(theme, scheme))
  const failures = checks.filter((check) => !check.passes)
  return {
    passes: failures.length === 0,
    checked: checks.length,
    failures: failures.map((check) => ({
      pair: `${check.foreground} on ${check.background}`,
      ratio: check.ratio === null ? null : Number(check.ratio.toFixed(2)),
      floor: check.floor,
    })),
  }
}

/**
 * The edit, as the tool's own vocabulary rather than the file's.
 *
 * Every field is `| undefined` as well as optional because `exactOptionalPropertyTypes` is on and
 * zod infers an absent input field as present-and-undefined. Spelling it out here is what lets the
 * handler pass what it parsed straight through instead of rebuilding the object key by key.
 */
export type DesignPatch = {
  mode?: Theme['mode'] | undefined
  preset?: string | undefined
  colors?:
    | {
        light?: Record<string, string | null> | undefined
        dark?: Record<string, string | null> | undefined
      }
    | undefined
  shape?:
    | {
        radius?: number | undefined
        borderWidth?: number | undefined
        boardWidth?: string | undefined
      }
    | undefined
  typography?: { font?: string | undefined; titleCase?: string | undefined } | undefined
  backdrop?: string | undefined
  backdropImage?: string | undefined
  backdropBlur?: number | undefined
  backdropDim?: number | undefined
  reset?: readonly string[] | undefined
  fit?: 'aa' | 'off' | 'refuse' | undefined
}

export type DesignReport = {
  applied: Record<string, unknown>
  adjustments: Partial<Record<Scheme, Adjustment[]>>
  unfittable: Partial<Record<Scheme, Unfittable[]>>
}

/**
 * What each `reset` word deletes.
 *
 * A Map rather than an object literal, because the word comes off the wire: `RESET_SETS['toString']`
 * on a plain object finds `Object.prototype.toString`, and the code then tried to iterate a
 * function — so `reset: ["toString"]` answered "tokens is not iterable" instead of the sentence
 * that tells the caller what the words are.
 */
const RESET_SETS = new Map<string, readonly string[]>([
  ['colors', [...COLOUR_TOKENS]],
  ['shape', SHAPE_RESET_TOKENS],
  ['type', TYPE_RESET_TOKENS],
  ['all', [...COLOUR_TOKENS, ...SHAPE_TOKENS]],
])

/** The two words that put COLOUR back, and therefore the two that make a repair pass worth running. */
const COLOUR_RESETS = new Set(['colors', 'all'])

const RESET_WORDS = [...RESET_SETS.keys(), 'background']

/**
 * The whole edit, as one pure function from the theme on disk to the theme that replaces it.
 *
 * Pure and synchronous so it can run INSIDE the store transaction, against the draft rather than
 * against a copy read a moment earlier. That is not tidiness: a fit is solved from the resolved
 * palette, and resolving against a stale theme would write overrides computed for colours somebody
 * else had already replaced. It is also the only implementation — `dryRun` calls this same
 * function, so a preview cannot describe an edit the write would not make.
 *
 * Throws with a message a caller can act on. The store hands the mutator a deep copy and discards
 * it on a throw, so a half-applied look is not a state this can reach.
 */
export function applyDesign(
  theme: Theme,
  patch: DesignPatch,
): { theme: Theme; report: DesignReport } {
  const cssVars: Record<Bucket, Record<string, string>> = {
    theme: { ...theme.cssVars.theme },
    light: { ...theme.cssVars.light },
    dark: { ...theme.cssVars.dark },
  }
  let surface = { ...theme.surface }
  const applied: Record<string, unknown> = {}

  const drop = (tokens: Iterable<string>) => {
    for (const bucket of BUCKETS) for (const token of tokens) delete cssVars[bucket][token]
  }

  // Reset first, so `{preset, reset:["all"]}` means "that preset, clean" rather than "that preset
  // under whatever I had already changed" — which is the request people actually make. Only the
  // token sets these tools own are deleted, never a whole bucket: a key this surface cannot write
  // came from somewhere else, and clearing someone else's is not what "reset the colours" says.
  for (const word of patch.reset ?? []) {
    if (word === 'background') {
      surface = { background: null, blur: 0, overlayOpacity: 0 }
      continue
    }
    const set = RESET_SETS.get(word)
    if (set !== undefined) {
      drop(set)
      continue
    }
    if (COLOUR_TOKENS.has(word) || (SHAPE_TOKENS as readonly string[]).includes(word)) {
      drop([word])
      continue
    }
    throw new Error(
      `cannot reset "${word}" — name a section (${RESET_WORDS.join(', ')}) or a token ` +
        `describe_theme lists`,
    )
  }
  if ((patch.reset ?? []).length > 0) applied.reset = patch.reset

  if (patch.mode !== undefined) applied.mode = patch.mode

  if (patch.preset !== undefined) {
    const preset = presetById(patch.preset)
    if (preset === undefined) {
      // `theme.preset` is a free string in the schema and an unknown one resolves to no preset at
      // all, so accepting this would write a file, report a revision and paint stock grey.
      throw new Error(
        `no preset "${patch.preset}" — search_presets lists all ${String(ALL_PRESETS.length)}`,
      )
    }
    applied.preset = preset.id
    // A preset may nominate a background, and picking one in the panel applies it. Only when the
    // call does not name its own, so "this preset, keep my wallpaper" stays expressible.
    const wantsOwn = patch.backdrop !== undefined || patch.backdropImage !== undefined
    if (preset.background !== undefined && !wantsOwn) {
      surface = { ...surface, background: `${GRADIENT_PREFIX}${preset.background}` }
      applied.backdrop = preset.background
    }
  }

  const colours: Partial<Record<Scheme, string[]>> = {}
  const unpinned: string[] = []
  for (const scheme of SCHEMES) {
    const wanted = patch.colors?.[scheme]
    if (wanted === undefined) continue
    const written: string[] = []
    for (const [token, value] of Object.entries(wanted)) {
      if (value === undefined) continue
      if (!COLOUR_TOKENS.has(token)) {
        throw new Error(
          `"${token}" is not a colour token — the thirteen are ${[...COLOUR_TOKENS].join(', ')}`,
        )
      }
      if (value === null) {
        delete cssVars[scheme][token]
        // The shared bucket outranks both schemes, so clearing only this one puts the token back
        // to whatever was pinned there rather than to the preset — which is not what was asked.
        if (cssVars.theme[token] !== undefined) {
          delete cssVars.theme[token]
          unpinned.push(token)
        }
        written.push(`${token} (cleared)`)
        continue
      }
      const parsed = parseColour(value)
      if (parsed === null) {
        throw new Error(
          `"${value}" is not a colour this understands: give "#rrggbb", "#rgb" or "oklch(L C H)"`,
        )
      }
      cssVars[scheme][token] = parsed
      // The shared bucket resolves LAST, above both schemes, so a colour pinned there makes this
      // write invisible: the caller asks for blue, the board stays red, and the tool reports
      // success. A colour has no business being scheme-independent, so the pin goes.
      if (cssVars.theme[token] !== undefined) {
        delete cssVars.theme[token]
        unpinned.push(token)
      }
      written.push(token)
    }
    if (written.length > 0) colours[scheme] = written
  }
  if (Object.keys(colours).length > 0) applied.colors = colours
  if (unpinned.length > 0) applied.unpinned = unpinned

  const shape: string[] = []
  if (patch.shape?.radius !== undefined) {
    cssVars.theme.radius = `${String(patch.shape.radius)}px`
    // The control radius tracks the tile's, at the ratio the panel's slider uses. Two sliders for
    // one decision was a choice nobody wanted to make twice.
    cssVars.theme['radius-control'] = `${String(Math.round(patch.shape.radius * 0.7))}px`
    shape.push('radius', 'radius-control')
  }
  if (patch.shape?.borderWidth !== undefined) {
    cssVars.theme['border-width'] = `${String(patch.shape.borderWidth)}px`
    shape.push('border-width')
  }
  if (patch.shape?.boardWidth !== undefined) {
    const width = boardWidthById(patch.shape.boardWidth)
    if (width === undefined) throw new Error(`no board width "${patch.shape.boardWidth}"`)
    cssVars.theme['max-width'] = width.value
    shape.push('max-width')
  }
  if (shape.length > 0) applied.shape = shape

  const typography: string[] = []
  if (patch.typography?.font !== undefined) {
    const stack = fontStackById(patch.typography.font)
    if (stack === undefined) throw new Error(`no font "${patch.typography.font}"`)
    cssVars.theme['font-sans'] = stack.value
    typography.push('font-sans')
  }
  if (patch.typography?.titleCase !== undefined) {
    const titleCase = titleCaseById(patch.typography.titleCase)
    if (titleCase === undefined) throw new Error(`no title case "${patch.typography.titleCase}"`)
    for (const [token, value] of Object.entries(titleCase.tokens)) {
      cssVars.theme[token] = value
      typography.push(token)
    }
  }
  if (typography.length > 0) applied.typography = typography

  if (patch.backdrop !== undefined && patch.backdropImage !== undefined) {
    throw new Error('name either backdrop or backdropImage, not both')
  }
  if (patch.backdrop !== undefined) {
    if (patch.backdrop === 'none') surface = { ...surface, background: null }
    else if (backgroundById(patch.backdrop) === undefined) {
      throw new Error(`no generated background "${patch.backdrop}"`)
    } else surface = { ...surface, background: `${GRADIENT_PREFIX}${patch.backdrop}` }
    applied.backdrop = patch.backdrop
  }
  if (patch.backdropImage !== undefined) {
    // The stored value is a path, and the caller supplies only the id half of it: the prefix is
    // built here, so there is no input that reaches the filesystem or the `url()`.
    if (!isAssetId(patch.backdropImage))
      throw new Error(`"${patch.backdropImage}" is not an image id`)
    surface = { ...surface, background: `/assets/${BACKGROUNDS_SUBDIR}/${patch.backdropImage}` }
    applied.backdropImage = patch.backdropImage
  }
  if (patch.backdropBlur !== undefined) {
    surface = { ...surface, blur: patch.backdropBlur }
    applied.backdropBlur = patch.backdropBlur
  }
  if (patch.backdropDim !== undefined) {
    surface = { ...surface, overlayOpacity: patch.backdropDim }
    applied.backdropDim = patch.backdropDim
  }

  let next = themeSchema.parse({
    ...theme,
    ...(patch.mode === undefined ? {} : { mode: patch.mode }),
    ...(patch.preset === undefined ? {} : { preset: patch.preset }),
    cssVars,
    surface,
  })

  /**
   * The repair pass.
   *
   * It runs on the schemes a call actually touched, because a brand palette is chosen to look like
   * a brand and not to clear 4.5:1 on an inset grey, and a board whose labels cannot be read is not
   * what anyone asked for. It does NOT run on a call that only moved a slider: silently rewriting
   * colours somebody else chose is the other way to get this wrong. `fit:"aa"` forces a pass over
   * both schemes, `fit:"off"` refuses one, `fit:"refuse"` makes an unreadable palette an error
   * instead of a repair — and every one of them reports the whole contrast verdict either way.
   */
  const touched = new Set<Scheme>()
  // A shape or type reset is not a colour change, and running the repair on one would rewrite
  // colours the call never mentioned — a request to put the corner radius back should not come
  // out having pinned four new palette overrides.
  if (patch.preset !== undefined || (patch.reset ?? []).some((word) => COLOUR_RESETS.has(word))) {
    for (const scheme of SCHEMES) touched.add(scheme)
  }
  for (const scheme of SCHEMES) if (colours[scheme] !== undefined) touched.add(scheme)
  if (patch.fit === 'aa' || patch.fit === 'refuse') for (const s of SCHEMES) touched.add(s)

  const adjustments: Partial<Record<Scheme, Adjustment[]>> = {}
  const unfittable: Partial<Record<Scheme, Unfittable[]>> = {}
  const unpinnedByFit = new Set<string>()
  if (patch.fit !== 'off') {
    for (const scheme of touched) {
      const fitted = fitPalette(resolveTokens(next, scheme))
      if (fitted.unfittable.length > 0) unfittable[scheme] = fitted.unfittable
      if (fitted.adjustments.length === 0) continue
      if (patch.fit === 'refuse') continue
      adjustments[scheme] = fitted.adjustments
      // Unpinned for the same reason a colour write is: an adjustment landing in the scheme
      // bucket under a token pinned in the shared one is a repair the report claims and the board
      // never shows. The fit is solved from the RESOLVED palette, so the pinned value is what it
      // measured — leaving it in place would contradict the number it just printed.
      const repaired = new Set(fitted.adjustments.map((entry) => entry.token))
      const shared = Object.fromEntries(
        Object.entries(next.cssVars.theme).filter(([token]) => !repaired.has(token)),
      )
      for (const token of repaired) {
        if (next.cssVars.theme[token] !== undefined) unpinnedByFit.add(token)
      }
      next = themeSchema.parse({
        ...next,
        cssVars: {
          ...next.cssVars,
          theme: shared,
          [scheme]: {
            ...next.cssVars[scheme],
            ...Object.fromEntries(fitted.adjustments.map((entry) => [entry.token, entry.to])),
          },
        },
      })
    }
  }

  if (patch.fit === 'refuse') {
    const failures = SCHEMES.flatMap((scheme) =>
      contrastOf(next, scheme).failures.map(
        (failure) =>
          `${scheme}: ${failure.pair} is ${String(failure.ratio ?? '—')}:1, below ${String(failure.floor)}:1`,
      ),
    )
    if (failures.length > 0) {
      throw new Error(`fit:"refuse" and the palette does not read:\n${failures.join('\n')}`)
    }
  }

  if (unpinnedByFit.size > 0) {
    applied.unpinned = [...new Set([...unpinned, ...unpinnedByFit])]
  }

  // A call that recognised nothing has to say so. Zod strips unknown keys rather than rejecting
  // them, so a misspelled section would otherwise be a successful no-op with a revision attached.
  // An explicit `fit` counts as something recognised: "check the palette and repair it" is a
  // request, and answering it with "nothing to change" made the same call succeed or fail
  // depending on state the caller could not see without another round trip.
  if (Object.keys(applied).length === 0 && patch.fit === undefined) {
    throw new Error(
      'nothing to change: name a preset, a mode, colors, shape, typography, a backdrop, a reset ' +
        'or fit',
    )
  }

  return { theme: next, report: { applied, adjustments, unfittable } }
}

export function registerDesignTools(
  server: McpServer,
  deps: { context: AppContext; actor: string },
): void {
  const { context } = deps

  server.registerTool(
    'describe_theme',
    {
      title: 'Describe the look',
      description:
        'The current theme: mode, preset, both palettes as hex, which values are overridden and ' +
        'in which bucket, shape, type, backdrop, the WCAG contrast verdict, and the thirteen ' +
        'colour tokens with what each one paints. Start here before changing anything, the same ' +
        'way describe_dashboard starts a layout change.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const { resolved, revision } = await context.state()
      const theme = resolved.theme
      const tokens = resolveTokens(theme, theme.mode === 'dark' ? 'dark' : 'light')
      const preset = presetById(theme.preset)
      const uploads = await listBackgrounds(env.assetsDir)

      return ok({
        revision,
        mode: theme.mode,
        // No "effective scheme" is invented here. Under `system` the page carries BOTH palettes
        // and the viewer's OS picks; the server cannot know which, so it says so instead.
        modeNote:
          theme.mode === 'system'
            ? 'both palettes are published and each viewer’s OS chooses, so a colour change ' +
              'that should be visible to everyone has to set light and dark'
            : `only the ${theme.mode} palette is painted`,
        preset: {
          id: theme.preset,
          label: preset?.label ?? null,
          blurb: preset?.blurb ?? null,
          finish: finishOf(theme.preset) === '' ? null : finishOf(theme.preset),
          known: preset !== undefined,
        },
        palette: { light: paletteOf(theme, 'light'), dark: paletteOf(theme, 'dark') },
        // Which values are custom rather than the preset's, per bucket. The panel shows this as a
        // count; an agent needs the names, and needs to see that `theme` outranks both schemes.
        overrides: {
          theme: Object.keys(theme.cssVars.theme),
          light: Object.keys(theme.cssVars.light),
          dark: Object.keys(theme.cssVars.dark),
        },
        // Ids where one fits, and the raw value always: a preset finish can set a board width or a
        // tracking that no id names, and reporting the nearest id would make a round trip through
        // this tool quietly rewrite it.
        shape: {
          radius: tokens.radius ?? null,
          radiusControl: tokens['radius-control'] ?? null,
          borderWidth: tokens['border-width'] ?? null,
          boardWidth: {
            id: boardWidthOf(tokens['max-width'])?.id ?? null,
            value: tokens['max-width'] ?? null,
          },
        },
        typography: {
          font: {
            id: fontStackOf(tokens['font-sans'])?.id ?? null,
            stack: tokens['font-sans'] ?? null,
          },
          titleCase: {
            id: titleCaseOf(tokens['title-transform']).id,
            transform: tokens['title-transform'] ?? null,
            tracking: tokens['title-tracking'] ?? null,
          },
        },
        backdrop: {
          ...describeBackdrop(theme.surface.background),
          blur: theme.surface.blur,
          dim: theme.surface.overlayOpacity,
        },
        contrast: { light: contrastOf(theme, 'light'), dark: contrastOf(theme, 'dark') },
        // The labels are what stop an agent guessing which grey is which: `muted` is the inset a
        // stat sits in, `border` is a card's edge, `control-border` is a field's. A brand's greys
        // land wrong precisely there.
        colorTokens: COLOUR_GROUPS.map((group) => ({
          group: group.title,
          tokens: group.tokens.map((token) => `${token.name} — ${token.label}`),
        })),
        // Uploaded through the design panel by a person. An agent may choose one by id and can
        // never add one: no tool here accepts an image, a URL or a path.
        uploadedImages: uploads.map((asset) => ({ id: asset.id, bytes: asset.bytes })),
      })
    },
  )

  server.registerTool(
    'search_presets',
    {
      title: 'Search the theme presets',
      description:
        'The ready-made looks: eleven curated ones and sixty-four generated palettes, sixteen ' +
        'hues in four finishes (flat, soft, sharp, glow). A preset carries the whole look, not ' +
        'just the hue — corner radius, border weight, elevation, the type stack and how a ' +
        'bookmark button is painted — and it is the only way to change those last three. Pick one ' +
        'as the base, then set_theme edits colours on top of it.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().max(64).optional(),
        finish: z.enum(['curated', 'flat', 'soft', 'sharp', 'glow']).optional(),
        scheme: z.enum(SCHEMES).optional(),
        limit: z.number().int().min(1).max(75).optional(),
      },
    },
    ({ query, finish, scheme, limit }) => {
      const shown: Scheme = scheme ?? 'light'
      const needle = (query ?? '').trim().toLowerCase()
      const curated = new Set(THEME_PRESETS.map((preset) => preset.id))
      const kindOf = (id: string) => (curated.has(id) ? 'curated' : finishOf(id))

      const matches = ALL_PRESETS.filter(
        (preset) =>
          (finish === undefined || kindOf(preset.id) === finish) &&
          (needle === '' ||
            `${preset.id} ${preset.label} ${preset.blurb}`.toLowerCase().includes(needle)),
      )

      return ok({
        total: matches.length,
        scheme: shown,
        matches: matches.slice(0, limit ?? 24).map((preset) => ({
          id: preset.id,
          label: preset.label,
          blurb: preset.blurb,
          finish: kindOf(preset.id),
          background: preset.background ?? null,
          // The four bars the gallery card draws, as hex — enough to tell a slate from a citron
          // without seventy-five full token maps. Read through the defaults rather than from the
          // preset alone: "Default" overrides nothing by design, so its own maps are empty and
          // browsing the presets reported it as a palette of five nulls.
          swatch: Object.fromEntries(
            (['background', 'surface', 'accent', 'ok', 'bad'] as const).map((token) => [
              token,
              toHex(
                preset[shown][token] ??
                  (shown === 'dark' ? DARK_DEFAULTS : LIGHT_DEFAULTS)[token] ??
                  '',
              ),
            ]),
          ),
        })),
      })
    },
  )

  // Described once on the pair rather than on each half: the same sentence under `light` and again
  // under `dark` is a quarter of this tool's schema spent saying one thing twice.
  const colourMap = z.record(z.string().max(48), z.string().max(64).nullable())
  const colours = z
    .object({ light: colourMap.optional(), dark: colourMap.optional() })
    .describe(
      'Token to colour, per scheme. The thirteen: background, foreground, surface, ' +
        'surface-foreground, muted, muted-foreground, border, control-border, accent, ' +
        'accent-foreground, ok, warn, bad. Values are "#rrggbb", "#rgb" or "oklch(L C H)"; null ' +
        'puts one back to the preset.',
    )

  server.registerTool(
    'set_theme',
    {
      title: 'Change the look',
      description:
        'Everything the Design panel can change, in one transaction: mode, preset, the thirteen ' +
        'colour tokens per scheme, corner radius, border weight, board width, font, tile-title ' +
        'case, backdrop, blur and dim. ' +
        'Colours are set per scheme — light and dark are separate palettes, and under the default ' +
        '"system" mode each viewer’s OS picks one, so a look that should reach everyone sets ' +
        'both in the same call. ' +
        'Whatever the palette, the board stays readable: a colour change is solved against the ' +
        'same WCAG matrix the test suite asserts, moving lightness only — hue is kept, chroma too ' +
        'unless the colour would leave the sRGB gamut — and every token that moved is reported. ' +
        'The three surfaces (background, surface, muted) are never moved: they are the design, so ' +
        'if they cannot carry readable text, change them yourself. ' +
        'Only what you name changes; everything else keeps its value. Writes republish the board, ' +
        'so use dryRun to try a palette without spending a generation.',
      annotations: { destructiveHint: true },
      inputSchema: {
        mode: z.enum(['light', 'dark', 'system']).optional(),
        preset: z.string().max(64).optional(),
        colors: colours.optional(),
        shape: z
          .object({
            radius: z.number().int().min(0).max(28).optional(),
            borderWidth: z.number().int().min(0).max(4).optional(),
            boardWidth: z.enum(ids(BOARD_WIDTHS)).optional(),
          })
          .optional(),
        typography: z
          .object({
            font: z.enum(ids(FONT_STACKS)).optional(),
            titleCase: z.enum(ids(TITLE_CASES)).optional(),
          })
          .optional(),
        /** A generated backdrop, by name. Recolours itself with the theme; needs no image. */
        backdrop: z
          .enum(['none', ...BACKGROUNDS.map((entry) => entry.id)] as [string, ...string[]])
          .optional(),
        /** An image already uploaded through the design panel, by the id describe_theme lists. */
        backdropImage: z.string().max(64).optional(),
        backdropBlur: z.number().int().min(0).max(40).optional(),
        backdropDim: z.number().min(0).max(0.9).optional(),
        reset: z
          .array(z.string().max(48))
          .max(40)
          .optional()
          .describe(
            'Back to the preset. Sections: "colors" (the thirteen), "shape" (radius, border ' +
              'weight, elevation, board width, the link treatment), "type" (fonts, title case and ' +
              'size), "background" (clears the backdrop, blur and dim), "all" (every token, not ' +
              'the backdrop). Or name single tokens. Applied before the rest of the call, and it ' +
              'never touches mode or preset.',
          ),
        fit: z
          .enum(['aa', 'off', 'refuse'])
          .optional()
          .describe(
            'What to do about contrast. Default: repair the schemes this call touches. "aa" ' +
              'repairs both schemes even if the call did not touch colour, "off" writes the ' +
              'palette exactly as given, "refuse" fails rather than write one that cannot be read.',
          ),
        dryRun: z.boolean().optional(),
        baseRevision: z.string().max(64).optional(),
      },
    },
    async (input) => {
      // The parsed input IS the patch: `DesignPatch` is written to accept zod's
      // present-but-undefined optionals, so there is no field-by-field rebuild to fall out of date.
      const patch: DesignPatch = input

      const answer = (theme: Theme, report: DesignReport, extra: Record<string, unknown>) => {
        const moved = SCHEMES.flatMap((scheme) =>
          (report.adjustments[scheme] ?? []).map((adjustment) => ({
            scheme,
            token: adjustment.token,
            // Named rather than buried in a boolean: a colour that is not the one the caller sent
            // has to be visible, or the next call sends the same failing value again.
            from: adjustment.fromHex ?? adjustment.from,
            to: adjustment.toHex ?? adjustment.to,
            why: adjustment.reason,
            ...(adjustment.chromaReduced === true ? { chromaReduced: true } : {}),
            ...(adjustment.resolved ? {} : { stillFails: true }),
          })),
        )
        const stuck = SCHEMES.flatMap((scheme) =>
          (report.unfittable[scheme] ?? []).map((entry) => `${scheme}: ${entry.why}`),
        )
        return ok({
          ...extra,
          mode: theme.mode,
          preset: theme.preset,
          applied: report.applied,
          adjusted: moved,
          ...(stuck.length > 0 ? { couldNotFit: stuck } : {}),
          contrast: { light: contrastOf(theme, 'light'), dark: contrastOf(theme, 'dark') },
          palette: { light: paletteOf(theme, 'light'), dark: paletteOf(theme, 'dark') },
          overrides: {
            theme: Object.keys(theme.cssVars.theme).length,
            light: Object.keys(theme.cssVars.light).length,
            dark: Object.keys(theme.cssVars.dark).length,
          },
        })
      }

      try {
        // An image has to still be there. The id is content-addressed and the panel can delete
        // one, so a stale id would otherwise write a background that 404s on every viewer.
        if (input.backdropImage !== undefined) {
          const uploads = await listBackgrounds(env.assetsDir)
          if (!uploads.some((asset) => asset.id === input.backdropImage)) {
            return fail(
              `no uploaded image "${input.backdropImage}" — describe_theme lists the ones there ` +
                `are, and images can only be added from the design panel in a browser`,
            )
          }
        }

        if (input.dryRun === true) {
          const { resolved } = await context.state()
          const { theme, report } = applyDesign(resolved.theme, patch)
          return answer(theme, report, { dryRun: true })
        }

        const outcome: { value: { theme: Theme; report: DesignReport } | null } = { value: null }
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            // Inside the transaction, against the draft: a fit solved from a theme read a moment
            // ago would be solved for colours a concurrent edit had already replaced.
            outcome.value = applyDesign(draft.theme, patch)
            draft.theme = outcome.value.theme
          },
          input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision },
        )
        await context.reload()
        void context.requestPublish(deps.actor)
        const applied = outcome.value as unknown as { theme: Theme; report: DesignReport }
        return answer(applied.theme, applied.report, { revision: result.revision })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )
}

export const DESIGN_TOOL_NAMES = ['describe_theme', 'search_presets', 'set_theme'] as const
