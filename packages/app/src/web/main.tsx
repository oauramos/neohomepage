import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { board, dashboard } from '../shared/board.ts'
import type { Resolved, ResolvedPage } from '../shared/resolved.ts'
import { emitPageCss } from '../shared/section-css.ts'
import { AboutPanel, ConfigPanel, ThemePanel } from './fab/panels.tsx'
import { WidgetsPanel } from './fab/WidgetsPanel.tsx'
import { SectionsPanel } from './fab/SectionsPanel.tsx'
import { Fab, type Tab } from './fab/Fab.tsx'
import { GridEditor } from './edit/GridEditor.tsx'
import { DesignFab } from './design/DesignFab.tsx'
import { DesignPanel, type ThemePatch } from './design/DesignPanel.tsx'
import { widgetTile } from '../shared/board.ts'
import type { LayoutItem } from '../shared/grid-geometry.ts'
import { DashboardClient, readEmbeddedState, type DashboardState } from './state.ts'
import { applyTheme } from './theme.ts'
import { useAutoHide } from './useAutoHide.ts'
import './styles.css'

/**
 * The browser entry point.
 *
 * The published page is already complete, so this does not paint anything new on load — it takes
 * over the same component tree, keeps it current over SSE, and adds the editor. On the shell
 * fallback (no generation published yet) there is nothing baked, so it fetches state first.
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
  editing,
  onToggleEdit,
  onChanged,
  onRemove,
  onFeatures,
}: {
  tab: Tab
  state: DashboardState
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
      return (
        <SectionsPanel
          pageId={state.resolved.pages[0]?.id ?? state.resolved.defaultPage}
          onChanged={onChanged}
        />
      )
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
 * The page's own stylesheet — board geometry and bookmark columns — kept current in the browser.
 *
 * The document arrives with this baked in, but it is baked as of the last publish. Adding a
 * widget or a section changes the resolved page over SSE long before the next generation is
 * written, and without this the new tile would sit at the top-left with no rules until a reload.
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

/** The `section\u0000breakpoint` keys whose geometry differs between two drafts, order-blind. */
function changedTiers(draft: Draft, original: Draft): Set<string> {
  const shape = (items: readonly LayoutItem[] | undefined) =>
    JSON.stringify(
      [...(items ?? [])]
        .map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
        .sort((a, b) => a.i.localeCompare(b.i, 'en-US')),
    )
  const changed = new Set<string>()
  for (const [section, tiers] of Object.entries(draft)) {
    for (const breakpoint of Object.keys(tiers)) {
      if (shape(tiers[breakpoint]) !== shape(original[section]?.[breakpoint])) {
        changed.add(`${section}\u0000${breakpoint}`)
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

  const page =
    state.resolved.pages.find((candidate) => candidate.id === state.resolved.defaultPage) ??
    state.resolved.pages[0]
  usePageCss(page)
  const now = useClock(
    page?.sections.some(
      (section) => section.kind === 'navbar' && section.items.some((item) => item.kind === 'clock'),
    ) ?? false,
  )

  /**
   * Edit mode works on a draft.
   *
   * A drag used to be written the moment you let go, which made "let me just see if it fits
   * there" a save. The draft holds every grid section's tiers; a drag or resize changes it and
   * nothing else, and the bar at the top offers Save or Discard. Save writes only the tiers that
   * changed, one request each, in one go.
   */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [original, setOriginal] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // What differs from the saved layout, tier by tier — derived, not counted. A drag that ends
  // where it began (dropped off the edge and clamped, or compacted straight back) is not a change,
  // and counting drag-stops instead of differences said "1 unsaved change" for exactly that.
  const dirty =
    draft === null || original === null ? new Set<string>() : changedTiers(draft, original)

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
      for (const key of dirty) {
        const [section, breakpoint] = key.split('\u0000') as [string, string]
        await fetch(`/api/pages/${page.id}/layout`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ section, breakpoint, items: draft[section]?.[breakpoint] ?? [] }),
        })
      }
      await client.refresh()
      // What was just written is the new baseline; the tiers that were not touched stay as read.
      setOriginal(structuredClone(draft))
      setLeaving(false)
    } finally {
      setSaving(false)
    }
  }

  /**
   * Two halves, because they run at different rates.
   *
   * `previewTheme` paints a draft on the next frame and touches no network — a slider drag calls it
   * sixty times a second. `saveTheme` is what the panel debounces, so one drag is one request and
   * one publish rather than a queue of them racing to be last.
   */
  // Stable identity: the panel paints from an effect keyed on this, so a new function every render
  // would repaint on every render rather than on every change.
  const previewTheme = useCallback((draft: Parameters<typeof applyTheme>[0]) => {
    applyTheme(draft)
  }, [])

  // Stable too: the gallery memoises sixty-four cards on the identity of the handler they call.
  const saveTheme = useCallback(
    async (patch: ThemePatch) => {
      await fetch('/api/theme', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await client.refresh()
    },
    [client],
  )

  const saveFeatures = async (patch: Partial<DashboardState['resolved']['features']>) => {
    await fetch('/api/dashboard', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: patch }),
    })
    await client.refresh()
  }

  const removeWidget = async (id: string) => {
    // The write gate refuses anything a cross-site form could send, and a body-less DELETE with no
    // content type looks like one — the header is the ticket, not the payload.
    await fetch(`/api/widgets/${id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    })
    await client.refresh()
  }

  return (
    <div data-neo-controls={hideControls ? 'hidden' : 'shown'}>
      {editing && page !== undefined && draft !== null ? (
        // Edit mode is the page with every grid section swapped for an editor of its own; the
        // navbar and the bookmark groups render exactly as they do in view mode.
        <div id="neo-root-content">
          <div className="nh-editbar" role="region" aria-label="Layout editing">
            <strong>Editing layout</strong>
            <span className="nh-editbar-note" aria-live="polite">
              {saving
                ? 'Saving…'
                : dirty.size === 0
                  ? 'Drag a tile by its handle, or its corner to resize. Nothing is saved until you say so.'
                  : leaving
                    ? 'Save or discard your changes before leaving.'
                    : `${String(dirty.size)} unsaved ${dirty.size === 1 ? 'change' : 'changes'}`}
            </span>
            <span className="nh-editbar-actions">
              {dirty.size > 0 ? (
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
                className={dirty.size > 0 ? 'nh-button-quiet' : 'nh-button'}
                disabled={saving}
                onClick={() => {
                  if (dirty.size > 0) setLeaving(true)
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
          <DesignPanel theme={state.resolved.theme} onPreview={previewTheme} onCommit={saveTheme} />
        )}
      </DesignFab>
    </div>
  )
}

async function boot(container: HTMLElement, root: Root): Promise<void> {
  const embedded = readEmbeddedState()
  const initial: DashboardState = {
    resolved: (embedded?.resolved ?? {
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
    }) as Resolved,
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

  // Always refresh: the baked state is as fresh as the last publish, and something may have
  // changed since. On the shell fallback this is what produces the first render at all.
  await client.refresh().catch(() => {
    if (embedded === null) container.innerHTML = ''
  })
}

/**
 * One React root for the container, for the life of the page.
 *
 * The empty state used to get a root of its own and `boot` created a second one on the same
 * element — React warns, and the first root is never unmounted, so it keeps its subscriptions and
 * its slice of memory for as long as the tab is open. On a wall display that stays open for weeks,
 * "never unmounted" is not a warning.
 */
const container = document.getElementById('neo-root')
if (container === null) throw new Error('#neo-root missing from the document')

const root = createRoot(container)
if (container.childElementCount === 0) root.render(<EmptyState />)
void boot(container, root)
