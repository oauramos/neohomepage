import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * The editor entry point: a button in the bottom-left corner.
 *
 * Bottom-left rather than bottom-right on purpose — the right corner is where every chat widget,
 * cookie banner and scroll-to-top button already lives, and a dashboard is something people leave
 * open next to other things.
 *
 * The badge counts unpublished changes. It is the whole reason the manual publish path is
 * discoverable rather than hunted for.
 */

export type Tab = 'edit' | 'widgets' | 'theme' | 'background' | 'about'

const TABS: { id: Tab; label: string }[] = [
  { id: 'edit', label: 'Edit layout' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'theme', label: 'Theme' },
  { id: 'background', label: 'Background' },
  { id: 'about', label: 'About' },
]

export function Fab({
  pending,
  connected,
  onPublish,
  renderTab,
}: {
  pending: boolean
  connected: boolean
  onPublish: () => Promise<void>
  renderTab: (tab: Tab, close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('edit')
  const [publishing, setPublishing] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  // Escape closes, and focus returns to the button that opened it — otherwise a keyboard user is
  // dropped at the top of the document with no idea where they were.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const publish = async () => {
    setPublishing(true)
    try {
      await onPublish()
    } finally {
      setPublishing(false)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="nh-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" className="nh-fab-glyph">
          ⌘
        </span>
        <span className="nh-sr-only">Open the dashboard editor</span>
        {pending ? (
          <span className="nh-fab-badge" title="unpublished changes">
            <span className="nh-sr-only">unpublished changes</span>
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="nh-modal-scrim" onClick={() => setOpen(false)}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="nh-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="nh-modal-head">
              <h2 id={titleId} className="nh-modal-title">
                Dashboard
              </h2>
              <span className="nh-modal-status" data-neo-connected={connected}>
                {connected ? 'live' : 'reconnecting'}
              </span>
              <button type="button" className="nh-modal-close" onClick={() => setOpen(false)}>
                <span className="nh-sr-only">Close</span>
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <div className="nh-modal-body">
              <nav className="nh-tabs" aria-label="Editor sections">
                {TABS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="nh-tab"
                    aria-current={tab === entry.id}
                    onClick={() => setTab(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </nav>
              <section className="nh-tab-panel">{renderTab(tab, () => setOpen(false))}</section>
            </div>

            <footer className="nh-modal-foot">
              <span className="nh-modal-note">
                {pending ? 'Unpublished changes' : 'Everything published'}
              </span>
              <button
                type="button"
                className="nh-button"
                disabled={publishing}
                onClick={() => void publish()}
              >
                {publishing ? 'Publishing…' : 'Regenerate'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  )
}
