import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Theme } from '../../server/config/schema.ts'
import {
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  hexToOklch,
  toHex,
} from '../../shared/contrast.ts'
import {
  BOARD_WIDTHS,
  COLOUR_GROUPS,
  FONT_STACKS,
  SHAPE_RESET_TOKENS,
  STAT_ALIGNS,
  STAT_STYLES,
  statAlignOf,
  statStyleOf,
  TITLE_CASES,
  TYPE_RESET_TOKENS,
  firstFamily,
  titleCaseOf,
} from '../../shared/design-options.ts'
import { BACKGROUNDS, GRADIENT_PREFIX } from '../../shared/theme-backgrounds.ts'
import { SHAPE_TOKENS, THEME_PRESETS } from '../../shared/theme-presets.ts'
import { GALLERY_FINISHES, GALLERY_PRESETS, finishOf } from '../../shared/theme-gallery.ts'
import { resolveTokens } from '../../shared/theme-tokens.ts'
import { currentScheme } from '../theme.ts'

/**
 * The design panel.
 *
 * Every control here is driven by LOCAL draft state, not by the theme that comes back from the
 * server. That is not a preference — a controlled input whose value arrives over the network is
 * unusable: each drag frame re-renders the input with the value from the previous round trip, so
 * the thumb is dragged back under the cursor and the control reads as dead. The draft is applied
 * to the page immediately and the write is debounced, so one drag is one request rather than sixty.
 *
 * Colour is edited with a picker and a hex field, because that is how people think about colour.
 * The stored token is still `oklch(L C H)`: `contrastRatio` parses nothing else, so a hex in
 * `cssVars` would make every ratio here and in `theme-contrast.test.ts` come back null. The
 * conversion happens on the way in, and the ratios shown are computed with the same function the
 * test suite asserts with — so the panel cannot claim a pair passes when CI would disagree.
 */

export type ThemePatch = {
  mode?: Theme['mode']
  preset?: string
  cssVars?: Partial<Record<'theme' | 'light' | 'dark', Record<string, string | null>>>
  surface?: { background?: string | null; blur?: number; overlayOpacity?: number }
}

const MODES: { id: Theme['mode']; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

/**
 * Tokens that are scheme-independent, so a draft edit belongs in the shared `theme` bucket rather
 * than in the current scheme's — a radius that changed when the OS went dark would be a bug.
 * Derived from the contract rather than restated, so a new shape token cannot be missed here.
 */
const SHAPE_LIKE = new Set<string>(SHAPE_TOKENS)

/**
 * One gallery swatch.
 *
 * Memoised and fed plain strings rather than the preset object: sixty-four cards re-rendering on
 * every keystroke of the filter — or on every frame of a slider drag in another section — is the
 * cost that would undo the paint work. Its colours come from the preset ALONE, not from
 * `resolveTokens` with the user's overrides on top, because a gallery card should show what the
 * theme is rather than what it would look like underneath your edits.
 */
const GalleryCard = memo(function GalleryCard({
  id,
  label,
  swatch,
  active,
  onPick,
}: {
  id: string
  label: string
  swatch: { background: string; surface: string; accent: string; ok: string; bad: string }
  active: boolean
  onPick: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="nh-swatch"
        aria-current={active}
        onClick={() => onPick(id)}
        title={label}
      >
        <span
          className="nh-swatch-bars"
          aria-hidden="true"
          style={{ background: swatch.background }}
        >
          <i style={{ background: swatch.surface }} />
          <i style={{ background: swatch.accent }} />
          <i style={{ background: swatch.ok }} />
          <i style={{ background: swatch.bad }} />
        </span>
        <span className="nh-swatch-name">{label}</span>
      </button>
    </li>
  )
})

/**
 * The board's width cap, drawn rather than named.
 *
 * A dropdown hides four options behind a click and asks you to translate "Comfortable" into a
 * picture of a page. The thing being chosen IS a picture — how much margin the board leaves — so
 * the control shows it: an outer frame for the viewport and an inner block for the board, with the
 * margin closing as the cap widens. `inset` is that margin in viewBox units, which is what makes
 * the four icons a scale instead of four unrelated glyphs.
 */
function WidthIcon({ inset }: { inset: number }) {
  return (
    <svg viewBox="0 0 24 18" width="26" height="20" aria-hidden="true" focusable="false">
      <rect
        x="0.75"
        y="0.75"
        width="22.5"
        height="16.5"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        opacity="0.45"
      />
      {/* Two stacked bars read as content rather than as a second frame. */}
      <rect x={2 + inset} y="4" width={20 - inset * 2} height="4" rx="1" fill="currentColor" />
      <rect x={2 + inset} y="10" width={20 - inset * 2} height="4" rx="1" fill="currentColor" />
    </svg>
  )
}

function Ratio({ value, floor, label }: { value: number | null; floor: number; label: string }) {
  const ok = value !== null && value >= floor
  return (
    <span className="nh-ratio" data-neo-pass={ok}>
      {label} {value === null ? '—' : `${value.toFixed(2)}:1`}
      <span className="nh-sr-only">{ok ? ` passes ${floor}:1` : ` fails ${floor}:1`}</span>
    </span>
  )
}

/** A colour picker, a hex field and a reset, all writing one token. */
function ColourRow({
  label,
  value,
  overridden,
  onChange,
  onReset,
}: {
  label: string
  value: string
  overridden: boolean
  onChange: (oklch: string) => void
  onReset: () => void
}) {
  const hex = toHex(value) ?? '#000000'
  // The text field keeps its own string so a half-typed "#3b8" is not thrown away or "corrected"
  // mid-keystroke; it only commits once it parses.
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? hex

  return (
    <div className="nh-colour">
      <label className="nh-colour-label">
        <span>{label}</span>
        <input
          type="color"
          className="nh-colour-picker"
          value={hex}
          onChange={(event) => {
            setTyped(null)
            const oklch = hexToOklch(event.target.value)
            if (oklch !== null) onChange(oklch)
          }}
        />
      </label>
      <input
        type="text"
        className="nh-colour-hex"
        value={shown}
        spellCheck={false}
        aria-label={`${label} hex`}
        onChange={(event) => {
          setTyped(event.target.value)
          const oklch = hexToOklch(event.target.value)
          if (oklch !== null) onChange(oklch)
        }}
        onBlur={() => setTyped(null)}
      />
      <button
        type="button"
        className="nh-colour-reset"
        disabled={!overridden}
        onClick={() => {
          setTyped(null)
          onReset()
        }}
        title="Back to the preset's value"
      >
        <span className="nh-sr-only">Reset {label}</span>
        <span aria-hidden="true">↺</span>
      </button>
    </div>
  )
}

export function DesignPanel({
  theme,
  onPreview,
  onCommit,
}: {
  theme: Theme
  /** Paint a draft immediately. No network. */
  onPreview: (theme: Theme) => void
  /** Persist. Debounced by this component, so one drag is one request. */
  onCommit: (patch: ThemePatch) => void
}) {
  const scheme = currentScheme(theme)
  const [section, setSection] = useState<
    'theme' | 'presets' | 'colour' | 'shape' | 'type' | 'background'
  >('theme')

  /**
   * The draft. Seeded empty and cleared whenever the preset or the scheme changes, because those
   * are wholesale changes the panel SHOULD follow; everything else is the user's own typing and
   * must survive the round trip that a save triggers.
   */
  const [uploads, setUploads] = useState<{ id: string; url: string; bytes: number }[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [finish, setFinish] = useState<string>('all')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [draftSurface, setDraftSurface] = useState<Partial<Theme['surface']>>({})
  useEffect(() => {
    setDraft({})
    setDraftSurface({})
  }, [theme.preset, theme.mode])

  /**
   * Swatch colours for all sixty-four, computed once per scheme rather than per render. Reading
   * straight from the preset skips resolveTokens entirely — the gallery does not need the merge.
   */
  const swatches = useMemo(
    () =>
      new Map(
        GALLERY_PRESETS.map((preset) => {
          const tokens = preset[scheme]
          return [
            preset.id,
            {
              background: tokens.background ?? '',
              surface: tokens.surface ?? '',
              accent: tokens.accent ?? '',
              ok: tokens.ok ?? '',
              bad: tokens.bad ?? '',
            },
          ] as const
        }),
      ),
    [scheme],
  )

  const gallery = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return GALLERY_PRESETS.filter(
      (preset) =>
        (finish === 'all' || finishOf(preset.id) === finish) &&
        (needle === '' || preset.label.toLowerCase().includes(needle)),
    )
  }, [query, finish])

  const saved = useMemo(() => resolveTokens(theme, scheme), [theme, scheme])
  const tokens = useMemo(() => ({ ...saved, ...draft }), [saved, draft])
  const surface = useMemo(
    () => ({ ...theme.surface, ...draftSurface }),
    [theme.surface, draftSurface],
  )

  /** The theme as the page should look right now, draft included. */
  const draftTheme = useMemo((): Theme => {
    const cssVars = {
      theme: { ...theme.cssVars.theme },
      light: { ...theme.cssVars.light },
      dark: { ...theme.cssVars.dark },
    }
    for (const [token, value] of Object.entries(draft)) {
      if (SHAPE_LIKE.has(token)) cssVars.theme[token] = value
      else cssVars[scheme][token] = value
    }
    return { ...theme, cssVars, surface }
  }, [theme, draft, scheme, surface])

  const loadUploads = useCallback(async () => {
    try {
      const response = await fetch('/api/assets/backgrounds')
      const body = (await response.json()) as {
        assets: { id: string; url: string; bytes: number }[]
      }
      setUploads(body.assets)
    } catch {
      setUploads([])
    }
  }, [])

  useEffect(() => {
    if (section === 'background') void loadUploads()
  }, [section, loadUploads])

  const pending = useRef<ThemePatch>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Accumulate into one patch and send it once the user stops moving. */
  const queue = (patch: ThemePatch) => {
    const merged = pending.current
    // Assigned only when present: under exactOptionalPropertyTypes, writing `undefined` is not the
    // same as leaving the key off, and the server reads a present-but-undefined key as a change.
    if (patch.mode !== undefined) merged.mode = patch.mode
    if (patch.preset !== undefined) merged.preset = patch.preset
    if (patch.surface !== undefined) merged.surface = { ...merged.surface, ...patch.surface }
    for (const bucket of ['theme', 'light', 'dark'] as const) {
      if (patch.cssVars?.[bucket] === undefined) continue
      merged.cssVars = {
        ...merged.cssVars,
        [bucket]: { ...merged.cssVars?.[bucket], ...patch.cssVars[bucket] },
      }
    }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const send = pending.current
      pending.current = {}
      onCommit(send)
    }, 250)
  }

  // A pending write must not be lost because the panel closed.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  /**
   * Send now, throwing away anything still queued.
   *
   * Picking a preset or a scheme is a wholesale change, and any token nudge still sitting in the
   * debounce was aimed at the preset you just left. Letting it fly would land AFTER the switch and
   * write itself into the new one — nudge the radius, immediately pick Terminal, and Terminal comes
   * out with rounded corners it does not have. Measured: radius 6px leaked into a preset whose own
   * radius is 0.
   */
  const commitNow = useCallback(
    (patch: ThemePatch) => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      pending.current = {}
      setDraft({})
      setDraftSurface({})
      onCommit(patch)
    },
    [onCommit],
  )

  const pickPreset = useCallback(
    (id: string) => {
      const preset = [...THEME_PRESETS, ...GALLERY_PRESETS].find((entry) => entry.id === id)
      commitNow({
        preset: id,
        // A preset may nominate a background. Applied only when it asks for one, so choosing a
        // plain theme does not silently strip the one you picked.
        ...(preset?.background === undefined
          ? {}
          : { surface: { background: `${GRADIENT_PREFIX}${preset.background}` } }),
      })
    },
    [commitNow],
  )

  const setColour = (token: string, value: string | null) => {
    setDraft((current) => {
      const next = { ...current }
      if (value === null) delete next[token]
      else next[token] = value
      return next
    })
    queue({ cssVars: { [scheme]: { [token]: value } } })
  }

  const setShape = (token: string, value: string | null) => {
    setDraft((current) => {
      const next = { ...current }
      if (value === null) delete next[token]
      else next[token] = value
      return next
    })
    queue({ cssVars: { theme: { [token]: value } } })
  }

  const setSurface = (patch: Partial<Theme['surface']>) => {
    setDraftSurface((current) => ({ ...current, ...patch }))
    queue({ surface: patch })
  }

  /**
   * Paint at most once per frame.
   *
   * A drag emits input events faster than the browser can repaint a board, so painting on every
   * one builds a backlog: the queue grows, the thumb runs ahead of the colours, and it reads as
   * lag. Coalescing to an animation frame throws away the intermediate states nobody could have
   * seen anyway and keeps at most one repaint in flight.
   */
  const frame = useRef<number | null>(null)
  useEffect(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      onPreview(draftTheme)
    })
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [draftTheme, onPreview])

  /**
   * Overrides outlive the preset that was active when they were made — which is right (a colour you
   * chose should not be undone by trying another theme) and invisible (you pick Terminal, the board
   * keeps your radius, and nothing says why it does not match the card). Counting them here is what
   * makes that legible, and the clear is the way back.
   */
  const overrideTokens = useMemo(
    () => [
      ...Object.keys(theme.cssVars.theme).map((token) => ['theme', token] as const),
      ...Object.keys(theme.cssVars[scheme]).map((token) => [scheme, token] as const),
    ],
    [theme.cssVars, scheme],
  )

  const clearOverrides = () => {
    const cssVars: ThemePatch['cssVars'] = {}
    for (const [bucket, token] of overrideTokens) {
      cssVars[bucket] = { ...cssVars[bucket], [token]: null }
    }
    commitNow({ cssVars })
  }

  const overridden = (token: string) =>
    draft[token] !== undefined ||
    theme.cssVars[scheme][token] !== undefined ||
    theme.cssVars.theme[token] !== undefined

  const radius = Number.parseFloat(tokens.radius ?? '12') || 0
  const borderWidth = Number.parseFloat(tokens['border-width'] ?? '1') || 0
  const activeBackground =
    surface.background?.startsWith(GRADIENT_PREFIX) === true
      ? surface.background.slice(GRADIENT_PREFIX.length)
      : null

  return (
    <div className="nh-design">
      {overrideTokens.length > 0 ? (
        <div className="nh-overrides">
          <span>
            {overrideTokens.length} custom {overrideTokens.length === 1 ? 'value' : 'values'} on top
            of <strong>{theme.preset}</strong>
          </span>
          <button type="button" className="nh-button-quiet" onClick={clearOverrides}>
            Clear
          </button>
        </div>
      ) : null}
      <nav className="nh-design-nav" aria-label="Design sections">
        {(['theme', 'presets', 'colour', 'shape', 'type', 'background'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className="nh-design-navitem"
            aria-current={section === id}
            onClick={() => setSection(id)}
          >
            {id === 'theme' ? 'Themes' : id[0]?.toUpperCase() + id.slice(1)}
          </button>
        ))}
      </nav>

      {section === 'theme' ? (
        <div className="nh-design-section">
          <div className="nh-seg" role="group" aria-label="Colour scheme">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className="nh-seg-item"
                aria-pressed={theme.mode === mode.id}
                onClick={() => commitNow({ mode: mode.id })}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <ul className="nh-preset-grid">
            {THEME_PRESETS.map((preset) => {
              const swatch = resolveTokens({ ...theme, preset: preset.id }, scheme)
              return (
                <li key={preset.id}>
                  <button
                    type="button"
                    className="nh-preset"
                    aria-current={theme.preset === preset.id}
                    onClick={() => pickPreset(preset.id)}
                  >
                    <span
                      className="nh-preset-swatch"
                      aria-hidden="true"
                      style={{
                        background: swatch.background,
                        borderRadius: swatch.radius,
                        borderWidth: swatch['border-width'],
                        borderColor: swatch.border,
                        borderStyle: 'solid',
                      }}
                    >
                      {(['surface', 'accent', 'ok', 'warn', 'bad'] as const).map((token) => (
                        <i
                          key={token}
                          style={{
                            background: swatch[token],
                            borderRadius: swatch['radius-control'],
                          }}
                        />
                      ))}
                    </span>
                    <strong>{preset.label}</strong>
                    <span className="nh-preset-blurb">{preset.blurb}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {section === 'presets' ? (
        <div className="nh-design-section">
          <p className="nh-panel-note">
            Sixty-four ready-made palettes — sixteen hues in four finishes. Pick one and it becomes
            the base; everything in the other tabs still edits on top of it.
          </p>
          <input
            type="search"
            className="nh-input"
            placeholder="Search palettes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search palettes"
          />
          <div className="nh-seg" role="group" aria-label="Finish">
            {['all', ...GALLERY_FINISHES].map((id) => (
              <button
                key={id}
                type="button"
                className="nh-seg-item"
                aria-pressed={finish === id}
                onClick={() => setFinish(id)}
              >
                {id === 'all' ? 'All' : id[0]?.toUpperCase() + id.slice(1)}
              </button>
            ))}
          </div>
          <p className="nh-panel-dim">{gallery.length} palettes</p>
          <ul className="nh-swatch-grid">
            {gallery.map((preset) => (
              <GalleryCard
                key={preset.id}
                id={preset.id}
                label={preset.label}
                swatch={
                  swatches.get(preset.id) ?? {
                    background: '',
                    surface: '',
                    accent: '',
                    ok: '',
                    bad: '',
                  }
                }
                active={theme.preset === preset.id}
                onPick={pickPreset}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {section === 'colour' ? (
        <div className="nh-design-section">
          <p className="nh-panel-note">
            Editing the <strong>{scheme}</strong> scheme — the other one keeps the preset&apos;s
            values. Pick a colour or type a hex; it is stored as OKLCH so the ratios below stay
            measurable.
          </p>
          <div className="nh-ratios">
            <Ratio
              label="text on page"
              floor={AA_NORMAL_TEXT}
              value={contrastRatio(tokens.foreground ?? '', tokens.background ?? '')}
            />
            <Ratio
              label="text on tile"
              floor={AA_NORMAL_TEXT}
              value={contrastRatio(tokens['surface-foreground'] ?? '', tokens.surface ?? '')}
            />
            <Ratio
              label="label on inset"
              floor={AA_NORMAL_TEXT}
              value={contrastRatio(tokens['muted-foreground'] ?? '', tokens.muted ?? '')}
            />
            <Ratio
              label="accent on tile"
              floor={AA_NON_TEXT}
              value={contrastRatio(tokens.accent ?? '', tokens.surface ?? '')}
            />
            <Ratio
              label="on accent"
              floor={AA_NORMAL_TEXT}
              value={contrastRatio(tokens['accent-foreground'] ?? '', tokens.accent ?? '')}
            />
          </div>
          {COLOUR_GROUPS.map((group) => (
            <fieldset key={group.title} className="nh-colour-group">
              <legend>{group.title}</legend>
              {group.tokens.map((token) => (
                <ColourRow
                  key={token.name}
                  label={token.label}
                  value={tokens[token.name] ?? 'oklch(0 0 0)'}
                  overridden={overridden(token.name)}
                  onChange={(value) => setColour(token.name, value)}
                  onReset={() => setColour(token.name, null)}
                />
              ))}
            </fieldset>
          ))}
        </div>
      ) : null}

      {section === 'shape' ? (
        <div className="nh-design-section">
          <label className="nh-field">
            <span>Corner radius</span>
            <input
              type="range"
              min={0}
              max={28}
              step={1}
              value={radius}
              onChange={(event) => {
                setShape('radius', `${event.target.value}px`)
                setShape('radius-control', `${Math.round(Number(event.target.value) * 0.7)}px`)
              }}
            />
            <output>{radius}px</output>
          </label>
          <label className="nh-field">
            <span>Border weight</span>
            <input
              type="range"
              min={0}
              max={4}
              step={1}
              value={borderWidth}
              onChange={(event) => setShape('border-width', `${event.target.value}px`)}
            />
            <output>{borderWidth}px</output>
          </label>
          <label className="nh-field">
            <span>Board width</span>
            <div className="nh-widths" role="group" aria-label="Board width">
              {BOARD_WIDTHS.map((width) => (
                <button
                  key={width.id}
                  type="button"
                  className="nh-width"
                  aria-pressed={(tokens['max-width'] ?? '1600px') === width.value}
                  title={width.label}
                  onClick={() => setShape('max-width', width.value)}
                >
                  <WidthIcon inset={width.inset} />
                  <span className="nh-sr-only">{width.label}</span>
                </button>
              ))}
            </div>
          </label>
          <button
            type="button"
            className="nh-button-quiet"
            onClick={() => {
              // Every non-type shape token, not the four this tab has controls for: a finish
              // picked over MCP also writes elevation and the link treatment, and a reset that
              // left those behind would claim to undo more than it did.
              for (const token of SHAPE_RESET_TOKENS) setShape(token, null)
            }}
          >
            Reset to the preset
          </button>
        </div>
      ) : null}

      {section === 'type' ? (
        <div className="nh-design-section">
          <div className="nh-seg" role="group" aria-label="Font">
            {FONT_STACKS.map((stack) => (
              <button
                key={stack.id}
                type="button"
                className="nh-seg-item"
                aria-pressed={firstFamily(tokens['font-sans']) === firstFamily(stack.value)}
                style={{ fontFamily: stack.value }}
                onClick={() => setShape('font-sans', stack.value)}
              >
                {stack.label}
              </button>
            ))}
          </div>
          <p className="nh-panel-note">
            System stacks only. The board has to render with no network and no bundle, so a webfont
            would be a request the offline mode cannot make.
          </p>
          <div className="nh-design-row">
            <span className="nh-field-label">Readings</span>
            <div className="nh-row nh-look">
              <span className="nh-look-caption">Box</span>
              <div className="nh-seg" role="group" aria-label="Reading box">
                {STAT_STYLES.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="nh-seg-item"
                    aria-pressed={statStyleOf(tokens['stat-bg']).id === entry.id}
                    onClick={() => {
                      for (const [token, value] of Object.entries(entry.tokens))
                        setShape(token, value)
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <span className="nh-look-caption">Align</span>
              <div className="nh-seg" role="group" aria-label="Reading alignment">
                {STAT_ALIGNS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="nh-seg-item"
                    aria-pressed={statAlignOf(tokens['stat-align']).id === entry.id}
                    onClick={() => {
                      for (const [token, value] of Object.entries(entry.tokens))
                        setShape(token, value)
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="nh-seg" role="group" aria-label="Tile titles">
            {TITLE_CASES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="nh-seg-item"
                aria-pressed={titleCaseOf(tokens['title-transform']).id === entry.id}
                onClick={() => {
                  for (const [token, value] of Object.entries(entry.tokens)) setShape(token, value)
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="nh-button-quiet"
            onClick={() => {
              for (const token of TYPE_RESET_TOKENS) setShape(token, null)
            }}
          >
            Reset to the preset
          </button>
        </div>
      ) : null}

      {section === 'background' ? (
        <div className="nh-design-section">
          <p className="nh-panel-note">
            Generated in CSS from the theme&apos;s own tokens, so they recolour when you change
            preset — and they still paint with JavaScript disabled.
          </p>
          <ul className="nh-bg-grid">
            <li>
              <button
                type="button"
                className="nh-bg"
                aria-current={surface.background === null}
                onClick={() => setSurface({ background: null })}
              >
                <span className="nh-bg-swatch" style={{ background: tokens.background }} />
                <span>None</span>
              </button>
            </li>
            {BACKGROUNDS.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="nh-bg"
                  aria-current={activeBackground === option.id}
                  onClick={() => setSurface({ background: `${GRADIENT_PREFIX}${option.id}` })}
                >
                  <span className="nh-bg-swatch" style={{ background: option.css }} />
                  <span>{option.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="nh-uploads">
            <div className="nh-row">
              <strong className="nh-field-label">Your images</strong>
              <label className="nh-button-quiet nh-upload">
                {busy ? 'Uploading…' : 'Add image'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
                  className="nh-upload-input"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file === undefined) return
                    setUploadError(null)
                    setBusy(true)
                    // Raw bytes, not multipart: the server names the file from its content, and a
                    // filename from a browser is the one field here that would be attacker text
                    // heading for a path.
                    void fetch('/api/assets/backgrounds', {
                      method: 'POST',
                      headers: { 'content-type': file.type },
                      body: file,
                    })
                      .then(async (response) => {
                        const body = (await response.json()) as { error?: string; url?: string }
                        if (!response.ok) {
                          setUploadError(body.error ?? 'The server refused it')
                          return
                        }
                        await loadUploads()
                        if (body.url !== undefined) setSurface({ background: body.url })
                      })
                      .catch(() => setUploadError('Upload failed'))
                      .finally(() => setBusy(false))
                  }}
                />
              </label>
            </div>
            {uploadError !== null ? (
              <p className="nh-status-note" data-neo-tone="bad">
                {uploadError}
              </p>
            ) : null}
            {uploads.length === 0 ? (
              <p className="nh-panel-dim">
                Nothing uploaded yet. Images land in <code>data/assets/backgrounds/</code>, which is
                a folder you can commit.
              </p>
            ) : (
              <ul className="nh-bg-grid">
                {/* The delete control is a SIBLING of the picker, not nested inside it: a button
                    within a button is invalid HTML, and the browser's own repair moves the inner
                    one out — to where its click handler is no longer the thing you aimed at. */}
                {uploads.map((asset) => (
                  <li key={asset.id} className="nh-upload-item">
                    <button
                      type="button"
                      className="nh-bg"
                      aria-current={surface.background === asset.url}
                      onClick={() => setSurface({ background: asset.url })}
                      title={`${String(Math.round(asset.bytes / 1024))} KB`}
                    >
                      <span
                        className="nh-bg-swatch"
                        style={{
                          backgroundImage: `url("${asset.url}")`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }}
                      />
                      <span>{asset.id.slice(0, 6)}</span>
                    </button>
                    <button
                      type="button"
                      className="nh-upload-delete"
                      title="Delete this image"
                      onClick={() => {
                        void fetch(`/api/assets/backgrounds/${asset.id}`, {
                          method: 'DELETE',
                          headers: { 'content-type': 'application/json' },
                        })
                          .then(loadUploads)
                          .then(() => {
                            if (surface.background === asset.url) setSurface({ background: null })
                          })
                      }}
                    >
                      <span className="nh-sr-only">Delete this image</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="nh-field">
            <span>Blur</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={surface.blur}
              onChange={(event) => setSurface({ blur: Number(event.target.value) })}
            />
            <output>{surface.blur}px</output>
          </label>
          <label className="nh-field">
            <span>Dim</span>
            <input
              type="range"
              min={0}
              max={0.9}
              step={0.05}
              value={surface.overlayOpacity}
              onChange={(event) => setSurface({ overlayOpacity: Number(event.target.value) })}
            />
            <output>{Math.round(surface.overlayOpacity * 100)}%</output>
          </label>
        </div>
      ) : null}
    </div>
  )
}
