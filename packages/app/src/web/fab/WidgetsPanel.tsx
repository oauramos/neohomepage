import { useCallback, useEffect, useRef, useState } from 'react'
import type { Field } from '@neohomepage/catalog-schema'
import type { ResolvedWidget } from '../../shared/resolved.ts'
import { FieldForm, type FieldValues } from '../form/FieldForm.tsx'
import type { DashboardState } from '../state.ts'
import { AddWidget, type CatalogEntry } from './AddWidget.tsx'

/**
 * The Widgets tab: what is on the page, and a way to add to it.
 *
 * One search box at the top does both jobs. Empty, the panel is the list of placed widgets, each
 * row opening into its own editor — title, section, how its readings are drawn, the options its
 * manifest declares, and a two-step remove. Typed into, it is the catalog, narrowed as you type;
 * choosing a type replaces the panel with the form, and adding brings you back to the list.
 *
 * Nothing here is saved on a "Save" button. An edit lands half a second after the last keystroke,
 * the same way the Sections tab works, and the row says so.
 */

export const WIDGET_KINDS = [
  { id: 'widget', label: 'Readings', blurb: 'Things that show a reading.' },
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
export function kindOf(type: string, catalog: ReadonlyMap<string, CatalogEntry>): WidgetKind {
  const kind = catalog.get(type)?.kind
  return kind === 'bookmark' || kind === 'tool' ? kind : 'widget'
}

const STATS = [
  { id: 'inherit', label: 'Default' },
  { id: 'plain', label: 'Plain' },
  { id: 'boxed', label: 'Boxed' },
] as const

const ALIGNS = [
  { id: 'inherit', label: 'Default' },
  { id: 'start', label: 'Left' },
  { id: 'center', label: 'Centred' },
] as const

type Look = ResolvedWidget['look']

type Patch = {
  title?: string | null
  section?: string
  look?: Partial<Look>
  config?: Record<string, string | number | boolean | null>
}

function stateLabel(state: string | undefined): { label: string; tone: string } {
  switch (state) {
    case 'fresh':
      return { label: 'live', tone: 'ok' }
    case 'stale':
      return { label: 'stale', tone: 'warn' }
    case 'error':
      return { label: 'error', tone: 'bad' }
    default:
      return { label: 'waiting', tone: 'muted' }
  }
}

function WidgetRow({
  widget,
  state,
  grids,
  currentSection,
  onPatch,
  onRemove,
  expanded,
  onToggle,
}: {
  widget: ResolvedWidget
  state: DashboardState
  grids: { id: string; title: string | null }[]
  currentSection: string
  onPatch: (patch: Patch) => Promise<boolean>
  onRemove: () => Promise<void>
  expanded: boolean
  onToggle: () => void
}) {
  const [fields, setFields] = useState<Field[] | null>(null)
  const [draftTitle, setDraftTitle] = useState(widget.title)
  const [config, setConfig] = useState<FieldValues>(widget.config as FieldValues)
  const [confirming, setConfirming] = useState(false)
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Edits made inside the pause merge into one write, so a title typed and a box clicked in the
  // same second both land rather than the later one replacing the earlier.
  const pending = useRef<Patch>({})
  const status = stateLabel(state.data[widget.id]?.meta.state)
  const target = state.resolved.targets.find((candidate) => candidate.id === widget.targetId)

  useEffect(() => {
    if (!expanded || fields !== null) return
    let live = true
    void fetch(`/api/catalog/${widget.type}/schema`)
      .then((response) => (response.ok ? (response.json() as Promise<{ config: Field[] }>) : null))
      .then((schema) => {
        if (live) setFields(schema?.config ?? [])
      })
      .catch(() => {
        if (live) setFields([])
      })
    return () => {
      live = false
    }
  }, [expanded, fields, widget.type])

  /** Save after a pause; the row shows what happened. */
  const schedule = (patch: Patch) => {
    const merged: Patch = { ...pending.current, ...patch }
    if (patch.look !== undefined) merged.look = { ...pending.current.look, ...patch.look }
    if (patch.config !== undefined) merged.config = { ...pending.current.config, ...patch.config }
    pending.current = merged
    if (timer.current !== null) clearTimeout(timer.current)
    setSaved('saving')
    timer.current = setTimeout(() => {
      timer.current = null
      const body = pending.current
      pending.current = {}
      void onPatch(body).then((ok) => setSaved(ok ? 'saved' : 'failed'))
    }, 500)
  }

  return (
    <li className="nh-wrow" data-neo-expanded={expanded}>
      <div className="nh-wrow-head">
        <button
          type="button"
          className="nh-wrow-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {widget.iconUrl === null ? (
            <span className="nh-wrow-icon nh-catalog-glyph" aria-hidden="true">
              {widget.title.charAt(0)}
            </span>
          ) : (
            <img className="nh-wrow-icon" src={widget.iconUrl} alt="" width={22} height={22} />
          )}
          <span className="nh-wrow-text">
            <span className="nh-wrow-title">{widget.title}</span>
            <span className="nh-wrow-meta">
              {widget.type}
              {grids.length > 1
                ? ` · ${grids.find((grid) => grid.id === currentSection)?.title ?? currentSection}`
                : ''}
            </span>
          </span>
          <span className="nh-dot" data-neo-tone={status.tone} title={status.label}>
            <span className="nh-sr-only">{status.label}</span>
          </span>
          <svg
            className="nh-chevron"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {expanded ? (
        <div className="nh-wrow-body">
          <div className="nh-form">
            <div className="nh-field">
              <label className="nh-field-label" htmlFor={`${widget.id}-title`}>
                Title
              </label>
              <input
                id={`${widget.id}-title`}
                className="nh-input"
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value)
                  schedule({ title: event.target.value === '' ? null : event.target.value })
                }}
              />
            </div>
            {grids.length > 1 ? (
              <div className="nh-field">
                <label className="nh-field-label" htmlFor={`${widget.id}-section`}>
                  Section
                </label>
                <select
                  id={`${widget.id}-section`}
                  className="nh-input"
                  value={currentSection}
                  onChange={(event) => schedule({ section: event.target.value })}
                >
                  {grids.map((grid) => (
                    <option key={grid.id} value={grid.id}>
                      {grid.title ?? grid.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          <div className="nh-field">
            <span className="nh-field-label">Readings</span>
            <div className="nh-row nh-look">
              <span className="nh-look-caption">Box</span>
              <div className="nh-seg" role="group" aria-label="Reading box">
                {STATS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="nh-seg-item"
                    aria-pressed={widget.look.stats === entry.id}
                    onClick={() => schedule({ look: { stats: entry.id } })}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <span className="nh-look-caption">Align</span>
              <div className="nh-seg" role="group" aria-label="Reading alignment">
                {ALIGNS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="nh-seg-item"
                    aria-pressed={widget.look.align === entry.id}
                    onClick={() => schedule({ look: { align: entry.id } })}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="nh-field-help">
              Default follows the dashboard: set it for every tile in the design panel, under Type.
            </p>
          </div>

          {fields === null ? (
            <p className="nh-panel-dim">Loading options…</p>
          ) : fields.length > 0 ? (
            <FieldForm
              fields={fields}
              values={config}
              onChange={(name, value) => {
                const next = { ...config, [name]: value }
                setConfig(next)
                schedule({ config: { [name]: value } })
              }}
            />
          ) : null}

          {target === undefined ? null : (
            <p className="nh-panel-dim nh-wrow-target">
              Reads from <code>{target.origin}</code>
              {Object.keys(target.secretRefs).length > 0 ? ' · credential on file' : ''}
            </p>
          )}

          <div className="nh-wrow-foot">
            <span className="nh-panel-dim" aria-live="polite">
              {saved === 'saving'
                ? 'Saving…'
                : saved === 'saved'
                  ? 'Saved'
                  : saved === 'failed'
                    ? 'Could not save'
                    : ''}
            </span>
            {confirming ? (
              <span className="nh-row">
                <span>Remove {widget.title}?</span>
                <button
                  type="button"
                  className="nh-button nh-button-danger"
                  onClick={() => void onRemove()}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="nh-button-quiet"
                  onClick={() => setConfirming(false)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="nh-button-quiet nh-quiet-danger"
                onClick={() => setConfirming(true)}
              >
                Remove…
              </button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  )
}

export function WidgetsPanel({
  state,
  onChanged,
  onRemove,
}: {
  state: DashboardState
  onChanged: () => void
  onRemove: (id: string) => void | Promise<void>
}) {
  const [kind, setKind] = useState<WidgetKind | 'all'>('all')
  const [catalog, setCatalog] = useState<Map<string, CatalogEntry>>(new Map())
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void fetch('/api/catalog')
      .then((response) => response.json() as Promise<{ manifests: CatalogEntry[] }>)
      .then((payload) => {
        if (live) setCatalog(new Map(payload.manifests.map((entry) => [entry.id, entry])))
      })
      .catch(() => {
        // A failed catalog fetch means everything lands under Widgets, which is the honest
        // fallback: the list is still complete and still removable.
      })
    return () => {
      live = false
    }
  }, [])

  const page = state.resolved.pages[0]
  const grids = (page?.sections ?? [])
    .filter((section) => section.kind === 'grid')
    .map((section) => ({ id: section.id, title: section.title }))
  const sectionOf = (widgetId: string) =>
    (page?.sections ?? []).find(
      (section) => section.kind === 'grid' && section.widgetIds.includes(widgetId),
    )?.id ??
    grids[0]?.id ??
    ''

  const placed = state.resolved.widgets.filter(
    (widget) => kind === 'all' || kindOf(widget.type, catalog) === kind,
  )

  const patch = useCallback(
    async (id: string, body: Patch) => {
      const response = await fetch(`/api/widgets/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      onChanged()
      return response.ok
    },
    [onChanged],
  )

  const searching = query.trim() !== '' || browsing
  const onEditing = useCallback((editing: boolean) => setAdding(editing), [])

  return (
    <div className="nh-panel-stack">
      {adding ? null : (
        <div className="nh-wsearch">
          <label className="nh-sr-only" htmlFor="neo-widget-search">
            Search widgets
          </label>
          <input
            id="neo-widget-search"
            className="nh-input"
            type="search"
            placeholder="Add a widget — search the catalog"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="nh-button-quiet"
            aria-pressed={browsing}
            onClick={() => setBrowsing((value) => !value)}
          >
            Browse
          </button>
        </div>
      )}

      {searching || adding ? (
        <>
          {adding ? null : (
            <div className="nh-seg nh-seg-compact" role="group" aria-label="Widget kind">
              <button
                type="button"
                className="nh-seg-item"
                aria-pressed={kind === 'all'}
                onClick={() => setKind('all')}
              >
                All
              </button>
              {WIDGET_KINDS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="nh-seg-item"
                  aria-pressed={kind === entry.id}
                  title={entry.blurb}
                  onClick={() => setKind(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <AddWidget
            query={query}
            {...(kind === 'all' ? {} : { kind })}
            onEditing={onEditing}
            onCancel={() => {
              setQuery('')
              setBrowsing(false)
            }}
            onAdded={() => {
              setQuery('')
              setBrowsing(false)
              onChanged()
            }}
          />
        </>
      ) : (
        <>
          <div className="nh-row nh-wlist-head">
            <span className="nh-field-label">
              On this page <span className="nh-count">{placed.length}</span>
            </span>
            {state.resolved.widgets.length > 0 ? (
              <div className="nh-seg nh-seg-compact" role="group" aria-label="Show">
                <button
                  type="button"
                  className="nh-seg-item"
                  aria-pressed={kind === 'all'}
                  onClick={() => setKind('all')}
                >
                  All
                </button>
                {WIDGET_KINDS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="nh-seg-item"
                    aria-pressed={kind === entry.id}
                    onClick={() => setKind(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {placed.length === 0 ? (
            <p className="nh-panel-note">
              {state.resolved.widgets.length === 0
                ? 'Nothing on the page yet. Search the catalog above, or press Browse.'
                : `No ${WIDGET_KINDS.find((entry) => entry.id === kind)?.label.toLowerCase() ?? 'items'} on this page.`}
            </p>
          ) : (
            <ul className="nh-wlist">
              {placed.map((widget) => (
                <WidgetRow
                  key={widget.id}
                  widget={widget}
                  state={state}
                  grids={grids}
                  currentSection={sectionOf(widget.id)}
                  expanded={open === widget.id}
                  onToggle={() => setOpen(open === widget.id ? null : widget.id)}
                  onPatch={(body) => patch(widget.id, body)}
                  onRemove={async () => {
                    await onRemove(widget.id)
                    setOpen(null)
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
