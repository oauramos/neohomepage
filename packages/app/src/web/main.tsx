import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { board, dashboard, defaultPageOf, widgetTile } from '../shared/board.ts'
import type { ResolvedPage } from '../shared/resolved.ts'
import { emitPageCss } from '../shared/section-css.ts'
import { AboutPanel, ConfigPanel, ThemePanel } from './fab/panels.tsx'
import { WidgetsPanel } from './fab/WidgetsPanel.tsx'
import { SectionsPanel } from './fab/SectionsPanel.tsx'
import { Fab, type Tab } from './fab/Fab.tsx'
import { GridEditor } from './edit/GridEditor.tsx'
import { DesignFab } from './design/DesignFab.tsx'
import { DesignPanel, type ThemePatch } from './design/DesignPanel.tsx'
import type { LayoutItem } from '../shared/grid-geometry.ts'
import { DashboardClient, readEmbeddedState, type DashboardState } from './state.ts'
import { applyTheme } from './theme.ts'
import { useAutoHide } from './useAutoHide.ts'
import './styles.css'

/**
 * Browser entry point: takes over the published page's component tree, keeps it current over SSE
 * and adds the editor. On the shell fallback (nothing published yet) it fetches state first.
 */

function EmptyState() {
  return (
    <div className="nh-empty">
      <h1>neohomepage</h1>
      <p>Loading the dashboard…</p>
    </div>
  )
}

function TabPanel({
  tab,
  state,
  pageId,
  editing,
  onToggleEdit,
  onChanged,
  onRemove,
  onFeatures,
}: {
  tab: Tab
  state: DashboardState
  pageId: string
  editing: boolean
  onToggleEdit: () => void
  onChanged: () => void
  onRemove: (id: string) => void
  onFeatures: (patch: Partial<DashboardState['resolved']['features']>) => void
}) {
  switch (tab) {
    case 'edit':
      return (
        <div className="nh-panel-stack">
          <p className="nh-panel-note">
            {editing
              ? 'Drag a tile by its handle to move it, or the corner to resize. Changes save when you let go.'
              : 'Turn on edit mode to rearrange the boards. This dialog closes so the whole page is yours to drag.'}
          </p>
          <button type="button" className="nh-button" onClick={onToggleEdit}>
            {editing ? 'Done editing' : 'Edit layout'}
          </button>
          {editing ? null : (
            <p className="nh-panel-dim">
              Moves are a draft until you press Save in the bar at the top of the page.
            </p>
          )}
        </div>
      )
    case 'sections':
      return <SectionsPanel pageId={pageId} onChanged={onChanged} />
    case 'widgets':
      return <WidgetsPanel state={state} onChanged={onChanged} onRemove={onRemove} />
    case 'theme':
      return <ThemePanel state={state} onImported={onChanged} />
    case 'config':
      return <ConfigPanel features={state.resolved.features} onChange={onFeatures} />
    case 'about':
      return <AboutPanel state={state} />
    default: {
      const exhaustive: never = tab
      throw new Error(`unhandled tab ${String(exhaustive)}`)
    }
  }
}

/**
 * Keeps the page stylesheet (board geometry, bookmark columns) current: the baked one is as of the
 * last publish, but SSE changes the resolved page before the next generation is written.
 */
function usePageCss(page: ResolvedPage | undefined): void {
  useEffect(() => {
    if (page === undefined) return
    let element = document.getElementById('neo-page-css')
    if (element === null) {
      element = document.createElement('style')
      element.id = 'neo-page-css'
      document.head.append(element)
    }
    element.textContent = emitPageCss(page)
  }, [page])
}

/** Every grid section's tiers, as the editor is changing them. */
type Draft = Record<string, Record<string, LayoutItem[]>>

function draftFrom(page: ResolvedPage): Draft {
  const draft: Draft = {}
  for (const section of page.sections) {
    if (section.kind !== 'grid') continue
    draft[section.id] = Object.fromEntries(
      Object.entries(section.layouts).map(([breakpoint, items]) => [
        breakpoint,
        items.map((item) => ({ ...item })),
      ]),
    )
  }
  return draft
}

/** The tiers whose geometry differs between two drafts, order-blind. */
function changedTiers(draft: Draft, original: Draft): { section: string; breakpoint: string }[] {
  const shape = (items: readonly LayoutItem[] | undefined) =>
    JSON.stringify(
      [...(items ?? [])]
        .map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
        .sort((a, b) => a.i.localeCompare(b.i, 'en-US')),
    )
  const changed: { section: string; breakpoint: string }[] = []
  for (const [section, tiers] of Object.entries(draft)) {
    for (const breakpoint of Object.keys(tiers)) {
      if (shape(tiers[breakpoint]) !== shape(original[section]?.[breakpoint])) {
        changed.push({ section, breakpoint })
      }
    }
  }
  return changed
}

/** A clock that ticks: re-render on the minute, and only if the page actually has one. */
function useClock(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!enabled) return
    const tick = () => setNow(new Date())
    tick()
    const delay = 60_000 - (Date.now() % 60_000) + 50
    let interval: ReturnType<typeof setInterval> | null = null
    const timeout = setTimeout(() => {
      tick()
      interval = setInterval(tick, 60_000)
    }, delay)
    return () => {
      clearTimeout(timeout)
      if (interval !== null) clearInterval(interval)
    }
  }, [enabled])
  return now
}

function App({ client }: { client: DashboardClient }) {
  const [state, setState] = useState(client.state)
  const [editing, setEditing] = useState(false)
  const hideControls = useAutoHide(
    state.resolved.features.autoHideControls && !editing,
    state.resolved.features.autoHideDelayMs,
  )

  useEffect(() => client.subscribe(setState), [client])
  useEffect(() => {
    client.connect()
    return () => client.disconnect()
  }, [client])
  useEffect(() => {
    applyTheme(state.resolved.theme)
  }, [state.resolved.theme])

  const page = defaultPageOf(state.resolved)
  usePageCss(page)
  const now = useClock(
    page?.sections.some(
      (section) => section.kind === 'navbar' && section.items.some((item) => item.kind === 'clock'),
    ) ?? false,
  )

  // Edit mode works on a draft of every grid section's tiers; Save writes only the changed ones.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [original, setOriginal] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // Derived by difference, not by counting drag-stops: a drag that ends where it began (clamped
  // or compacted back) is not a change.
  const dirty = draft === null || original === null ? [] : changedTiers(draft, original)

  const startEditing = () => {
    if (page === undefined) return
    setDraft(draftFrom(page))
    setOriginal(draftFrom(page))
    setLeaving(false)
    setEditing(true)
  }

  const stopEditing = () => {
    setEditing(false)
    setDraft(null)
    setOriginal(null)
    setLeaving(false)
  }

  const changeLayout = (section: string, breakpoint: string, items: LayoutItem[]) => {
    setDraft((current) =>
      current === null
        ? current
        : { ...current, [section]: { ...current[section], [breakpoint]: items } },
    )
  }

  const discardLayout = () => {
    if (original !== null) setDraft(structuredClone(original))
    setLeaving(false)
  }

  const saveLayout = async () => {
    if (draft === null || page === undefined) return
    setSaving(true)
    try {
      for (const { section, breakpoint } of dirty) {
        const response = await fetch(`/api/pages/${page.id}/layout`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ section, breakpoint, items: draft[section]?.[breakpoint] ?? [] }),
        })
        if (!response.ok) throw new Error(`layout save failed: ${response.status}`)
      }
      await client.refresh()
      setOriginal(structuredClone(draft))
      setLeaving(false)
    } finally {
      setSaving(false)
    }
  }

  // Both theme handlers must be identity-stable: the panel keys its paint effect on `onPreview`
  // (applyTheme, module-level) and the gallery memoises its cards on `onCommit`, which the panel
  // debounces so a slider drag is one request.
  const saveTheme = useCallback(
    (patch: ThemePatch) => client.write('PATCH', '/api/theme', patch),
    [client],
  )

  const saveFeatures = (patch: Partial<DashboardState['resolved']['features']>) =>
    client.write('PATCH', '/api/dashboard', { features: patch })

  const removeWidget = (id: string) => client.write('DELETE', `/api/widgets/${id}`)

  return (
    <div data-neo-controls={hideControls ? 'hidden' : 'shown'}>
      {editing && page !== undefined && draft !== null ? (
        <div id="neo-root-content">
          <div className="nh-editbar" role="region" aria-label="Layout editing">
            <strong>Editing layout</strong>
            <span className="nh-editbar-note" aria-live="polite">
              {saving
                ? 'Saving…'
                : dirty.length === 0
                  ? 'Drag a tile by its handle, or its corner to resize. Nothing is saved until you say so.'
                  : leaving
                    ? 'Save or discard your changes before leaving.'
                    : `${String(dirty.length)} unsaved ${dirty.length === 1 ? 'change' : 'changes'}`}
            </span>
            <span className="nh-editbar-actions">
              {dirty.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="nh-button-quiet"
                    disabled={saving}
                    onClick={discardLayout}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="nh-button"
                    disabled={saving}
                    onClick={() => void saveLayout()}
                  >
                    Save layout
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className={dirty.length > 0 ? 'nh-button-quiet' : 'nh-button'}
                disabled={saving}
                onClick={() => {
                  if (dirty.length > 0) setLeaving(true)
                  else stopEditing()
                }}
              >
                Done
              </button>
            </span>
          </div>
          {board(page, state.resolved, state.data, {
            now,
            renderGrid: (section) => (
              <GridEditor
                key={section.id}
                section={section}
                layouts={draft[section.id] ?? section.layouts}
                widgets={state.resolved.widgets}
                renderWidget={(widget) => widgetTile(widget, state.data[widget.id])}
                onChange={(breakpoint, items) => changeLayout(section.id, breakpoint, items)}
                onRemove={(id) => void removeWidget(id)}
              />
            ),
          })}
        </div>
      ) : (
        dashboard(state.resolved, state.data, { now })
      )}
      <Fab
        pending={state.pending}
        connected={state.connected}
        onPublish={() => client.publish()}
        renderTab={(tab, close) => (
          <TabPanel
            tab={tab}
            state={state}
            pageId={page?.id ?? state.resolved.defaultPage}
            editing={editing}
            onToggleEdit={() => {
              if (editing) stopEditing()
              else startEditing()
              close()
            }}
            onChanged={() => void client.refresh()}
            onRemove={(id) => void removeWidget(id)}
            onFeatures={(patch) => void saveFeatures(patch)}
          />
        )}
      />
      <DesignFab>
        {() => (
          <DesignPanel theme={state.resolved.theme} onPreview={applyTheme} onCommit={saveTheme} />
        )}
      </DesignFab>
    </div>
  )
}

async function boot(root: Root): Promise<void> {
  const embedded = readEmbeddedState()
  const initial: DashboardState = {
    resolved: embedded?.resolved ?? {
      schemaVersion: 1,
      title: 'neohomepage',
      defaultPage: 'home',
      generatedAt: new Date().toISOString(),
      pages: [],
      widgets: [],
      targets: [],
      theme: {
        mode: 'system',
        preset: 'default',
        cssVars: { theme: {}, light: {}, dark: {} },
        surface: { background: null, blur: 0, overlayOpacity: 0 },
      },
      features: { autoHideControls: false, autoHideDelayMs: 5000 },
      diagnostics: [],
    },
    data: {},
    revision: '',
    generation: null,
    pending: false,
    connected: false,
  }

  const client = new DashboardClient(initial)
  root.render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  )

  // Baked state is only as fresh as the last publish; on the shell fallback this is the first render.
  await client.refresh().catch(() => {})
}

// One React root for the life of the page: a second root on the same element is never unmounted
// and keeps its subscriptions for as long as the tab is open.
const container = document.getElementById('neo-root')
if (container === null) throw new Error('#neo-root missing from the document')

const root = createRoot(container)
if (container.childElementCount === 0) root.render(<EmptyState />)
void boot(root)
