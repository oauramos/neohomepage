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
import { fail, ok, revisionOption } from './result.ts'

/**
 * MCP tools over the design panel. Nothing here accepts CSS: every string that reaches a stylesheet
 * is a preset, token value or closed-set member this project authored. Schema keys say `colors`
 * because zod strips unknown keys, so the American spelling would otherwise be a silent no-op.
 */

const SCHEMES = ['light', 'dark'] as const
type Scheme = (typeof SCHEMES)[number]
const BUCKETS = ['theme', ...SCHEMES] as const
type Bucket = (typeof BUCKETS)[number]

const COLOUR_TOKENS = new Set<string>(THEME_TOKENS)

const ids = (values: readonly { id: string }[]) => values.map((value) => value.id)

/**
 * Accepts hex or `oklch(L C H)` and re-emits oklch, the only form `contrastRatio` reads. Parsed and
 * rebuilt, never passed through, so no caller text reaches the stylesheet.
 */
function parseColour(value: string): string | null {
  const trimmed = value.trim()
  const parsed = parseOklch(trimmed) ?? parseOklch(hexToOklch(trimmed) ?? '')
  return parsed === null ? null : formatInGamut(parsed.l, parsed.c, parsed.h)
}

function describeBackdrop(background: string | null) {
  if (background === null) return { kind: 'none' as const, id: null }
  if (background.startsWith(GRADIENT_PREFIX)) {
    const id = background.slice(GRADIENT_PREFIX.length)
    return { kind: 'gradient' as const, id, label: backgroundById(id)?.label ?? null }
  }
  return { kind: 'image' as const, id: background.slice(background.lastIndexOf('/') + 1) }
}

/** The resolved palette as hex, the form callers send back. */
function paletteOf(theme: Theme, scheme: Scheme): Record<string, string | null> {
  const tokens = resolveTokens(theme, scheme)
  return Object.fromEntries(
    // A non-colour value reports as null rather than being echoed back as text.
    THEME_TOKENS.map((token) => [token, toHex(tokens[token] ?? '')]),
  )
}

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
 * Every field is `| undefined` as well as optional because `exactOptionalPropertyTypes` is on and
 * zod infers an absent input field as present-and-undefined.
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

// A Map, not an object literal: the word comes off the wire, and `toString` on a plain object
// would find `Object.prototype.toString`.
const RESET_SETS = new Map<string, readonly string[]>([
  ['colors', [...COLOUR_TOKENS]],
  ['shape', SHAPE_RESET_TOKENS],
  ['type', TYPE_RESET_TOKENS],
  ['all', [...COLOUR_TOKENS, ...SHAPE_TOKENS]],
])

/** Reset words that touch colour and so warrant a repair pass. */
const COLOUR_RESETS = new Set(['colors', 'all'])

const RESET_WORDS = [...RESET_SETS.keys(), 'background']

/**
 * Pure and synchronous so it runs inside the store transaction against the draft: a fit solved
 * against a stale theme would write overrides for colours already replaced. `dryRun` uses this same
 * function. Throws with an actionable message; the store discards the draft on a throw.
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

  // Reset first so `{preset, reset:["all"]}` means that preset, clean. Only the token sets these
  // tools own are deleted, never a whole bucket.
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
      // `theme.preset` is a free string; an unknown one resolves to no preset and paints grey.
      throw new Error(
        `no preset "${patch.preset}" — search_presets lists all ${String(ALL_PRESETS.length)}`,
      )
    }
    applied.preset = preset.id
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
        // The shared bucket outranks both schemes; left pinned it would mask the clear.
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
      // The shared bucket resolves above both schemes and would mask this write.
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
    // Same ratio as the panel's radius slider.
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
    // The caller supplies only the id; the path prefix is built here so no input reaches the
    // filesystem or the `url()`.
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

  // The contrast repair runs only on the schemes this call changed colours in, so a slider-only or
  // shape-reset call never rewrites colours it did not mention.
  const touched = new Set<Scheme>()
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
      // As with a colour write: a repair under a token pinned in the shared bucket never shows.
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

  // Zod strips unknown keys, so without this a misspelled section would be a successful no-op. An
  // explicit `fit` alone is a request to check and repair, so it counts.
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
        // Names, not the panel's counts: an agent needs to see `theme` outranks both schemes.
        overrides: {
          theme: Object.keys(theme.cssVars.theme),
          light: Object.keys(theme.cssVars.light),
          dark: Object.keys(theme.cssVars.dark),
        },
        // Id and raw value both: a preset finish can set a width or tracking no id names.
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
        colorTokens: COLOUR_GROUPS.map((group) => ({
          group: group.title,
          tokens: group.tokens.map((token) => `${token.name} — ${token.label}`),
        })),
        // An agent may pick an upload by id but never add one.
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
          // Read through the defaults: "Default" overrides nothing, so its own maps are empty.
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
        backdrop: z.enum(['none', ...ids(BACKGROUNDS)]).optional(),
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
      const patch: DesignPatch = input

      const answer = (theme: Theme, report: DesignReport, extra: Record<string, unknown>) => {
        const moved = SCHEMES.flatMap((scheme) =>
          (report.adjustments[scheme] ?? []).map((adjustment) => ({
            scheme,
            token: adjustment.token,
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
        // The panel can delete an upload, so a stale id would write a background that 404s.
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

        let applied: { theme: Theme; report: DesignReport } | undefined
        const result = await context.store.transaction(
          deps.actor,
          (draft) => {
            applied = applyDesign(draft.theme, patch)
            draft.theme = applied.theme
          },
          revisionOption(input),
        )
        if (applied === undefined) throw new Error('theme transaction did not run')
        await context.reload()
        void context.requestPublish(deps.actor)
        return answer(applied.theme, applied.report, { revision: result.revision })
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    },
  )
}

export const DESIGN_TOOL_NAMES = ['describe_theme', 'search_presets', 'set_theme'] as const
