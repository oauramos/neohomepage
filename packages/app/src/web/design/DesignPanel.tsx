import { useMemo, useState } from 'react'
import type { Theme } from '../../server/config/schema.ts'
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio } from '../../shared/contrast.ts'
import { BACKGROUNDS, GRADIENT_PREFIX } from '../../shared/theme-backgrounds.ts'
import { THEME_PRESETS } from '../../shared/theme-presets.ts'
import { resolveTokens } from '../../shared/theme-tokens.ts'
import { currentScheme } from '../theme.ts'

/**
 * The design panel.
 *
 * Everything here writes a CSS custom property, so a change is visible before it is saved and the
 * saved form is the same value — there is no separate preview renderer to drift.
 *
 * Colour is edited as hue and chroma with the preset's LIGHTNESS held fixed, rather than with a
 * hex picker. That is the whole trick: lightness is what WCAG contrast is mostly made of, so
 * rotating hue moves the accent a long way visually while keeping the ratio the preset was solved
 * for. A hex picker would let anyone produce an unreadable dashboard in one drag. The live ratio
 * readout is computed with `contrastRatio` — the same function the test suite asserts with — so
 * the panel cannot claim a pair passes when CI would say otherwise.
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

const FONT_STACKS: { id: string; label: string; value: string }[] = [
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

/** Pull L, C and H back out of a token so a slider can move one of them. */
function parts(value: string | undefined): { l: number; c: number; h: number } | null {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value ?? '')
  if (match === null) return null
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) }
}

function oklch(p: { l: number; c: number; h: number }): string {
  return `oklch(${p.l.toFixed(3)} ${p.c.toFixed(3)} ${p.h.toFixed(1)})`
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

export function DesignPanel({
  theme,
  onPatch,
}: {
  theme: Theme
  onPatch: (patch: ThemePatch) => void
}) {
  const scheme = currentScheme(theme)
  const tokens = useMemo(() => resolveTokens(theme, scheme), [theme, scheme])
  const [section, setSection] = useState<'theme' | 'colour' | 'shape' | 'type' | 'background'>(
    'theme',
  )

  const accent = parts(tokens.accent)
  const background = tokens.background ?? ''
  const surface = tokens.surface ?? ''

  /** Per-scheme, so nudging the accent in dark does not repaint light too. */
  const setToken = (token: string, value: string | null) =>
    onPatch({ cssVars: { [scheme]: { [token]: value } } })

  const setShape = (token: string, value: string | null) =>
    onPatch({ cssVars: { theme: { [token]: value } } })

  const radius = Number.parseFloat(tokens.radius ?? '12') || 0
  const borderWidth = Number.parseFloat(tokens['border-width'] ?? '1') || 0
  /** Which generated background is selected, or null for none/an uploaded image. */
  const activeBackground =
    theme.surface.background?.startsWith(GRADIENT_PREFIX) === true
      ? theme.surface.background.slice(GRADIENT_PREFIX.length)
      : null

  return (
    <div className="nh-design">
      <nav className="nh-design-nav" aria-label="Design sections">
        {(['theme', 'colour', 'shape', 'type', 'background'] as const).map((id) => (
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
                onClick={() => onPatch({ mode: mode.id })}
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
                    onClick={() => onPatch({ preset: preset.id })}
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

      {section === 'colour' && accent !== null ? (
        <div className="nh-design-section">
          <p className="nh-panel-note">
            Editing the <strong>{scheme}</strong> scheme. Lightness is held at the value this preset
            was checked against, so the contrast below stays honest as you move the hue.
          </p>
          <label className="nh-field">
            <span>Accent hue</span>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={accent.h}
              onChange={(event) =>
                setToken('accent', oklch({ ...accent, h: Number(event.target.value) }))
              }
            />
            <output>{Math.round(accent.h)}°</output>
          </label>
          <label className="nh-field">
            <span>Accent intensity</span>
            <input
              type="range"
              min={0}
              max={0.3}
              step={0.005}
              value={accent.c}
              onChange={(event) =>
                setToken('accent', oklch({ ...accent, c: Number(event.target.value) }))
              }
            />
            <output>{accent.c.toFixed(3)}</output>
          </label>
          <label className="nh-field">
            <span>Accent lightness</span>
            <input
              type="range"
              min={0.2}
              max={0.95}
              step={0.01}
              value={accent.l}
              onChange={(event) =>
                setToken('accent', oklch({ ...accent, l: Number(event.target.value) }))
              }
            />
            <output>{accent.l.toFixed(2)}</output>
          </label>
          <div className="nh-ratios">
            <Ratio
              label="on page"
              floor={AA_NON_TEXT}
              value={contrastRatio(tokens.accent ?? '', background)}
            />
            <Ratio
              label="on tile"
              floor={AA_NON_TEXT}
              value={contrastRatio(tokens.accent ?? '', surface)}
            />
            <Ratio
              label="label on fill"
              floor={AA_NORMAL_TEXT}
              value={contrastRatio(tokens['accent-foreground'] ?? '', tokens.accent ?? '')}
            />
          </div>
          <button
            type="button"
            className="nh-button-quiet"
            onClick={() => setToken('accent', null)}
          >
            Reset to the preset
          </button>
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
            <select
              value={tokens['max-width'] ?? '1600px'}
              onChange={(event) => setShape('max-width', event.target.value)}
            >
              <option value="1200px">Narrow</option>
              <option value="1600px">Comfortable</option>
              <option value="2000px">Wide</option>
              <option value="none">Full bleed</option>
            </select>
          </label>
          <button
            type="button"
            className="nh-button-quiet"
            onClick={() => {
              setShape('radius', null)
              setShape('radius-control', null)
              setShape('border-width', null)
              setShape('max-width', null)
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
                aria-pressed={tokens['font-sans'] === stack.value}
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
          <div className="nh-seg" role="group" aria-label="Tile titles">
            <button
              type="button"
              className="nh-seg-item"
              aria-pressed={tokens['title-transform'] === 'uppercase'}
              onClick={() => {
                setShape('title-transform', 'uppercase')
                setShape('title-tracking', '0.08em')
              }}
            >
              UPPERCASE
            </button>
            <button
              type="button"
              className="nh-seg-item"
              aria-pressed={tokens['title-transform'] !== 'uppercase'}
              onClick={() => {
                setShape('title-transform', 'none')
                setShape('title-tracking', '0')
              }}
            >
              Sentence case
            </button>
          </div>
          <button
            type="button"
            className="nh-button-quiet"
            onClick={() => {
              setShape('font-sans', null)
              setShape('title-transform', null)
              setShape('title-tracking', null)
            }}
          >
            Reset to the preset
          </button>
        </div>
      ) : null}

      {section === 'background' ? (
        <div className="nh-design-section">
          <p className="nh-panel-note">
            Generated in CSS from the theme's own tokens, so they recolour when you change preset —
            and they still paint with JavaScript disabled.
          </p>
          <ul className="nh-bg-grid">
            <li>
              <button
                type="button"
                className="nh-bg"
                aria-current={theme.surface.background === null}
                onClick={() => onPatch({ surface: { background: null } })}
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
                  onClick={() =>
                    onPatch({ surface: { background: `${GRADIENT_PREFIX}${option.id}` } })
                  }
                >
                  <span className="nh-bg-swatch" style={{ background: option.css }} />
                  <span>{option.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <label className="nh-field">
            <span>Blur</span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={theme.surface.blur}
              onChange={(event) => onPatch({ surface: { blur: Number(event.target.value) } })}
            />
            <output>{theme.surface.blur}px</output>
          </label>
          <label className="nh-field">
            <span>Dim</span>
            <input
              type="range"
              min={0}
              max={0.9}
              step={0.05}
              value={theme.surface.overlayOpacity}
              onChange={(event) =>
                onPatch({ surface: { overlayOpacity: Number(event.target.value) } })
              }
            />
            <output>{Math.round(theme.surface.overlayOpacity * 100)}%</output>
          </label>
        </div>
      ) : null}
    </div>
  )
}
