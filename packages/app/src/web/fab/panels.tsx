import { useEffect, useRef, useState } from 'react'
import type { Resolved } from '../../shared/resolved.ts'
import type { DashboardState } from '../state.ts'
import { AddWidget } from './AddWidget.tsx'

/**
 * The editor's panels, split out of `main.tsx` once there were five of them.
 *
 * The split is not cosmetic: Theme and Config both hold their own draft state, and a `switch` in a
 * render function has nowhere to keep it — the components below can.
 */

export const WIDGET_KINDS = [
  { id: 'widget', label: 'Widgets', blurb: 'Things that show a reading.' },
  { id: 'bookmark', label: 'Bookmarks', blurb: 'Things that open a link.' },
  { id: 'tool', label: 'Tools', blurb: 'Things you act on.' },
] as const

export type WidgetKind = (typeof WIDGET_KINDS)[number]['id']

/**
 * Which kind a placed widget is.
 *
 * The manifest carries `kind`, but a RESOLVED widget carries only its type — so the kind is looked
 * up from the catalog the editor already fetched. A type the catalog does not know (a widget whose
 * manifest was removed) is shown under Widgets rather than hidden, because hiding it would make an
 * un-removable tile invisible in the one screen that can remove it.
 */
export function kindOf(type: string, catalog: Map<string, string>): WidgetKind {
  const kind = catalog.get(type)
  return kind === 'bookmark' || kind === 'tool' ? kind : 'widget'
}

export function WidgetsPanel({
  state,
  onChanged,
  onRemove,
}: {
  state: DashboardState
  onChanged: () => void
  onRemove: (id: string) => void
}) {
  const [kind, setKind] = useState<WidgetKind>('widget')
  const [catalog, setCatalog] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let live = true
    void fetch('/api/catalog')
      .then(
        (response) => response.json() as Promise<{ manifests: { id: string; kind?: string }[] }>,
      )
      .then((payload) => {
        if (!live) return
        setCatalog(new Map(payload.manifests.map((m) => [m.id, m.kind ?? 'widget'])))
      })
      .catch(() => {
        // A failed catalog fetch means everything lands under Widgets, which is the honest
        // fallback: the list is still complete and still removable.
      })
    return () => {
      live = false
    }
  }, [])

  const placed = state.resolved.widgets.filter((widget) => kindOf(widget.type, catalog) === kind)
  const counts = new Map(
    WIDGET_KINDS.map((entry) => [
      entry.id,
      state.resolved.widgets.filter((widget) => kindOf(widget.type, catalog) === entry.id).length,
    ]),
  )

  return (
    <div className="nh-panel-stack">
      <div className="nh-seg" role="group" aria-label="Widget kind">
        {WIDGET_KINDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="nh-seg-item"
            aria-pressed={kind === entry.id}
            onClick={() => setKind(entry.id)}
          >
            {entry.label}
            <span className="nh-count">{counts.get(entry.id) ?? 0}</span>
          </button>
        ))}
      </div>

      <AddWidget onAdded={onChanged} kind={kind} />

      {placed.length === 0 ? (
        <p className="nh-panel-note">
          No {WIDGET_KINDS.find((entry) => entry.id === kind)?.label.toLowerCase()} yet.{' '}
          {WIDGET_KINDS.find((entry) => entry.id === kind)?.blurb}
        </p>
      ) : (
        <ul className="nh-panel-list">
          {placed.map((widget) => (
            <li key={widget.id}>
              <strong>{widget.title}</strong> <code>{widget.type}</code>{' '}
              <span className="nh-panel-dim">{state.data[widget.id]?.meta.state ?? 'pending'}</span>{' '}
              <button
                type="button"
                className="nh-button-quiet"
                onClick={() => onRemove(widget.id)}
                aria-label={`Remove ${widget.title}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Theme import and export.
 *
 * The same JSON either way, and the same JSON that lives in `config/theme.json` — so someone who
 * pulls the repo, edits the file and pushes has done exactly what this box does, and someone who
 * has never seen a terminal can still move a look between two installs. That equivalence is the
 * point: this is not an export format, it is the file.
 */
export function ThemePanel({
  state,
  onImported,
}: {
  state: DashboardState
  onImported: () => void
}) {
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; message: string } | null>(null)
  const exported = JSON.stringify(state.resolved.theme, null, 2)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exported)
      setStatus({ tone: 'ok', message: 'Copied' })
    } catch {
      setStatus({ tone: 'bad', message: 'The browser refused clipboard access' })
    }
  }

  const download = () => {
    const blob = new Blob([exported], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'theme.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const apply = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch {
      setStatus({ tone: 'bad', message: 'That is not valid JSON' })
      return
    }
    const theme = parsed as {
      mode?: string
      preset?: string
      cssVars?: Record<string, Record<string, string>>
      surface?: unknown
    }
    if (typeof theme !== 'object' || theme === null) {
      setStatus({ tone: 'bad', message: 'Expected an object' })
      return
    }

    // Replace rather than merge: an import is "make it look like this", and merging would leave
    // whatever the current theme had that the imported one does not mention.
    const cleared = Object.fromEntries(
      (['theme', 'light', 'dark'] as const).map((bucket) => [
        bucket,
        {
          ...Object.fromEntries(
            Object.keys(state.resolved.theme.cssVars[bucket]).map((token) => [token, null]),
          ),
          ...(theme.cssVars?.[bucket] ?? {}),
        },
      ]),
    )

    const response = await fetch('/api/theme', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...theme, cssVars: cleared }),
    })
    if (!response.ok) {
      const body = (await response.json()) as { error?: string }
      setStatus({ tone: 'bad', message: body.error ?? 'The server refused it' })
      return
    }
    setStatus({ tone: 'ok', message: 'Applied' })
    setDraft('')
    onImported()
  }

  return (
    <div className="nh-panel-stack">
      <p className="nh-panel-note">
        This is <code>config/theme.json</code> exactly as it is on disk — colours, sizes, fonts and
        the background. Copy it to move a look to another install, or commit the folder and pull it
        on the other machine instead.
      </p>

      <div className="nh-row">
        <button type="button" className="nh-button-quiet" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="nh-button-quiet" onClick={download}>
          Download
        </button>
      </div>
      <textarea className="nh-code" readOnly value={exported} rows={8} aria-label="Current theme" />

      <label className="nh-field">
        <span className="nh-field-label">Import</span>
        <textarea
          className="nh-code"
          value={draft}
          rows={5}
          placeholder="Paste a theme.json here"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="nh-row">
        <button
          type="button"
          className="nh-button"
          disabled={draft.trim() === ''}
          onClick={() => void apply()}
        >
          Apply
        </button>
        {status !== null ? (
          <span className="nh-status-note" data-neo-tone={status.tone}>
            {status.message}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function ConfigPanel({
  features,
  onChange,
}: {
  features: Resolved['features']
  onChange: (patch: Partial<Resolved['features']>) => void
}) {
  return (
    <div className="nh-panel-stack">
      <label className="nh-toggle">
        <input
          type="checkbox"
          checked={features.autoHideControls}
          onChange={(event) => onChange({ autoHideControls: event.target.checked })}
        />
        <span>
          <strong>Hide the floating buttons</strong>
          <span className="nh-panel-dim">
            They fade once you stop interacting and come back when the pointer nears their corner.
            Keyboard focus always brings them back, so they can still be tabbed to.
          </span>
        </span>
      </label>

      <label className="nh-field">
        <span className="nh-field-label">Hide after</span>
        <input
          type="range"
          min={1000}
          max={20000}
          step={500}
          disabled={!features.autoHideControls}
          value={features.autoHideDelayMs}
          onChange={(event) => onChange({ autoHideDelayMs: Number(event.target.value) })}
        />
        <output>{(features.autoHideDelayMs / 1000).toFixed(1)}s</output>
      </label>
    </div>
  )
}

const LINKS = [
  {
    href: 'https://github.com/oauramos/neohomepage',
    label: 'Project on GitHub',
    icon: (
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .3.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    ),
  },
  {
    href: 'https://github.com/oauramos/neohomepage/wiki',
    label: 'Wiki',
    icon: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z" />
        <path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5" />
      </>
    ),
  },
  {
    href: 'https://github.com/oauramos',
    label: '@oauramos',
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
  },
  {
    href: 'https://github.com/oauramos/neohomepage/issues/new/choose',
    label: 'Report a problem',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16.5v.01" />
      </>
    ),
  },
]

export function AboutPanel({ state }: { state: DashboardState }) {
  const [health, setHealth] = useState<{ uptimeSeconds: number } | null>(null)
  const once = useRef(false)

  useEffect(() => {
    if (once.current) return
    once.current = true
    void fetch('/api/health')
      .then((response) => response.json() as Promise<{ uptimeSeconds: number }>)
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  const uptime = (seconds: number) => {
    if (seconds < 60) return `${String(seconds)}s`
    if (seconds < 3600) return `${String(Math.round(seconds / 60))}m`
    if (seconds < 86400) return `${String(Math.round(seconds / 3600))}h`
    return `${String(Math.round(seconds / 86400))}d`
  }

  return (
    <div className="nh-panel-stack">
      <dl className="nh-panel-facts">
        <dt>Revision</dt>
        <dd>
          <code>{state.revision === '' ? '—' : state.revision}</code>
        </dd>
        <dt>Generation</dt>
        <dd>{state.generation ?? 'none'}</dd>
        <dt>Widgets</dt>
        <dd>{state.resolved.widgets.length}</dd>
        <dt>Live feed</dt>
        <dd>{state.connected ? 'connected' : 'reconnecting'}</dd>
        <dt>Uptime</dt>
        <dd>{health === null ? '—' : uptime(health.uptimeSeconds)}</dd>
      </dl>

      {state.resolved.diagnostics.length > 0 ? (
        <ul className="nh-panel-list">
          {state.resolved.diagnostics.map((line) => (
            <li key={line} className="nh-panel-dim">
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="nh-links">
        {LINKS.map((link) => (
          <li key={link.href}>
            {/* noreferrer as well as noopener: the referrer would leak the dashboard's hostname,
                which on a homelab is often a private name the user has not published anywhere. */}
            <a href={link.href} target="_blank" rel="noreferrer">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {link.icon}
              </svg>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
