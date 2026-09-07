import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { dashboard } from '../shared/board.ts'
import type { Resolved } from '../shared/resolved.ts'
import { Fab, type Tab } from './fab/Fab.tsx'
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

function TabPanel({ tab, state }: { tab: Tab; state: DashboardState }) {
  switch (tab) {
    case 'edit':
      return (
        <p className="nh-panel-note">
          Drag-and-drop editing arrives with the grid editor. Widgets on this page:{' '}
          {state.resolved.widgets.length}.
        </p>
      )
    case 'widgets':
      return (
        <ul className="nh-panel-list">
          {state.resolved.widgets.map((widget) => (
            <li key={widget.id}>
              <strong>{widget.title}</strong> <code>{widget.type}</code>{' '}
              <span className="nh-panel-dim">{state.data[widget.id]?.meta.state ?? 'pending'}</span>
            </li>
          ))}
        </ul>
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

  useEffect(() => client.subscribe(setState), [client])
  useEffect(() => {
    client.connect()
    return () => client.disconnect()
  }, [client])
  useEffect(() => {
    applyTheme(state.resolved.theme)
  }, [state.resolved.theme])

  return (
    <>
      {dashboard(state.resolved, state.data)}
      <Fab
        pending={state.pending}
        connected={state.connected}
        onPublish={() => client.publish()}
        renderTab={(tab) => <TabPanel tab={tab} state={state} />}
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
