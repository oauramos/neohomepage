import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { dashboard } from '../shared/board.ts'
import type { Resolved } from '../shared/resolved.ts'
import { AddWidget } from './fab/AddWidget.tsx'
import { Fab, type Tab } from './fab/Fab.tsx'
import { GridEditor } from './edit/GridEditor.tsx'
import { widgetTile } from '../shared/board.ts'
import type { LayoutItem } from '../shared/grid-geometry.ts'
import { DashboardClient, readEmbeddedState, type DashboardState } from './state.ts'
import { applyTheme } from './theme.ts'
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
}: {
  tab: Tab
  state: DashboardState
  editing: boolean
  onToggleEdit: () => void
  onChanged: () => void
  onRemove: (id: string) => void
}) {
  switch (tab) {
    case 'edit':
      return (
        <div className="nh-panel-stack">
          <p className="nh-panel-note">
            {editing
              ? 'Drag a tile by its handle to move it, or the corner to resize. Changes save when you let go.'
              : 'Turn on edit mode to rearrange the board.'}
          </p>
          <button type="button" className="nh-button" onClick={onToggleEdit}>
            {editing ? 'Done editing' : 'Edit layout'}
          </button>
        </div>
      )
    case 'widgets':
      return (
        <div className="nh-panel-stack">
          <AddWidget onAdded={onChanged} />
          <ul className="nh-panel-list">
            {state.resolved.widgets.map((widget) => (
              <li key={widget.id}>
                <strong>{widget.title}</strong> <code>{widget.type}</code>{' '}
                <span className="nh-panel-dim">
                  {state.data[widget.id]?.meta.state ?? 'pending'}
                </span>{' '}
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
        </div>
      )
    case 'theme':
      return (
        <p className="nh-panel-note">
          Mode: <code>{state.resolved.theme.mode}</code>. Colours apply immediately when changed and
          are baked into the page on the next publish.
        </p>
      )
    case 'background':
      return <p className="nh-panel-note">Background uploads land with the assets store.</p>
    case 'about':
      return (
        <dl className="nh-panel-facts">
          <dt>Revision</dt>
          <dd>
            <code>{state.revision}</code>
          </dd>
          <dt>Generation</dt>
          <dd>{state.generation ?? 'none'}</dd>
          <dt>Live feed</dt>
          <dd>{state.connected ? 'connected' : 'reconnecting'}</dd>
        </dl>
      )
    default: {
      const exhaustive: never = tab
      throw new Error(`unhandled tab ${String(exhaustive)}`)
    }
  }
}

function App({ client }: { client: DashboardClient }) {
  const [state, setState] = useState(client.state)
  const [editing, setEditing] = useState(false)

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

  const saveLayout = async (breakpoint: string, items: LayoutItem[]) => {
    await fetch(`/api/pages/${page?.id ?? 'home'}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ breakpoint, items }),
    })
    await client.refresh()
  }

  const removeWidget = async (id: string) => {
    await fetch(`/api/widgets/${id}`, { method: 'DELETE' })
    await client.refresh()
  }

  return (
    <>
      {editing && page !== undefined ? (
        <GridEditor
          page={page}
          widgets={state.resolved.widgets}
          renderWidget={(widget) => widgetTile(widget, state.data[widget.id])}
          onCommit={saveLayout}
          onRemove={(id) => void removeWidget(id)}
        />
      ) : (
        dashboard(state.resolved, state.data)
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
          />
        )}
      />
    </>
  )
}

async function boot(): Promise<void> {
  const root = document.getElementById('neo-root')
  if (root === null) throw new Error('#neo-root missing from the document')

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
      diagnostics: [],
    }) as Resolved,
    data: {},
    revision: '',
    generation: null,
    pending: false,
    connected: false,
  }

  const client = new DashboardClient(initial)
  createRoot(root).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  )

  // Always refresh: the baked state is as fresh as the last publish, and something may have
  // changed since. On the shell fallback this is what produces the first render at all.
  await client.refresh().catch(() => {
    if (embedded === null) root.innerHTML = ''
  })
}

const placeholder = document.getElementById('neo-root')
if (placeholder !== null && placeholder.childElementCount === 0) {
  createRoot(placeholder).render(<EmptyState />)
}
void boot()
