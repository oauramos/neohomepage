import { useId, useRef, useState, type ReactNode } from 'react'
import { useFocusTrap } from '../useFocusTrap.ts'

/**
 * Editor entry point: a bottom-left button with a badge for unpublished changes. Bottom-left
 * because the right corner is where chat widgets and cookie banners already live.
 */

export type Tab = 'widgets' | 'sections' | 'edit' | 'theme' | 'config' | 'about'

/** Inline line icons so the editor ships no icon font. */
const ICONS: Record<Tab, ReactNode> = {
  widgets: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  sections: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <rect x="3" y="15" width="18" height="5" rx="1.5" />
    </>
  ),
  edit: (
    <>
      <path d="M5 9l-3 3 3 3" />
      <path d="M19 9l3 3-3 3" />
      <path d="M9 5l3-3 3 3" />
      <path d="M9 19l3 3 3-3" />
      <path d="M2 12h20" />
      <path d="M12 2v20" />
    </>
  ),
  theme: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  config: (
    <>
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <circle cx="16" cy="6" r="2" />
      <path d="M4 18h2" />
      <path d="M10 18h10" />
      <circle cx="8" cy="18" r="2" />
      <path d="M4 12h6" />
      <path d="M14 12h6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8v.01" />
    </>
  ),
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'widgets', label: 'Widgets' },
  { id: 'sections', label: 'Sections' },
  { id: 'edit', label: 'Layout' },
  { id: 'theme', label: 'Theme' },
  { id: 'config', label: 'Config' },
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
  const [tab, setTab] = useState<Tab>('widgets')
  const [publishing, setPublishing] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  useFocusTrap(open, dialogRef, () => {
    setOpen(false)
    // Return focus to the opener so a keyboard user is not dropped at the top of the document.
    buttonRef.current?.focus()
  })

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
        className="nh-fab nh-fab-editor"
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
              <button
                type="button"
                className="nh-modal-action"
                disabled={publishing}
                onClick={() => void publish()}
                title={publishing ? 'Publishing…' : 'Regenerate the published page'}
                data-neo-pending={pending}
              >
                <span className="nh-sr-only">
                  {publishing ? 'Publishing' : 'Regenerate the published page'}
                </span>
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={publishing ? 'nh-spin' : undefined}
                >
                  <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
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
                    <svg
                      aria-hidden="true"
                      className="nh-tab-icon"
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {ICONS[entry.id]}
                    </svg>
                    <span>{entry.label}</span>
                  </button>
                ))}
              </nav>
              <section className="nh-tab-panel">{renderTab(tab, () => setOpen(false))}</section>
            </div>

            <footer className="nh-modal-foot">
              <span className="nh-modal-note">
                {pending ? 'Unpublished changes' : 'Everything published'}
              </span>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  )
}
