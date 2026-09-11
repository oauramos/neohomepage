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

  const saveLayout = async (section: string, breakpoint: string, items: LayoutItem[]) => {
    await fetch(`/api/pages/${page?.id ?? 'home'}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section, breakpoint, items }),
    })
    await client.refresh()
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
    await fetch(`/api/widgets/${id}`, { method: 'DELETE' })
    await client.refresh()
  }

  return (
    <div data-neo-controls={hideControls ? 'hidden' : 'shown'}>
      {editing && page !== undefined ? (
        // Edit mode is the page with every grid section swapped for an editor of its own; the
        // navbar and the bookmark groups render exactly as they do in view mode.
        <div id="neo-root-content">
          {board(page, state.resolved, state.data, {
            now,
            renderGrid: (section) => (
              <GridEditor
                key={section.id}
                section={section}
                widgets={state.resolved.widgets}
                renderWidget={(widget) => widgetTile(widget, state.data[widget.id])}
                onCommit={(breakpoint, items) => saveLayout(section.id, breakpoint, items)}
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
              setEditing((value) => !value)
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
