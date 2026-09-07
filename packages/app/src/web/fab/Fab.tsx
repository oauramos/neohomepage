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

export type Tab = 'edit' | 'widgets' | 'theme' | 'config' | 'about'

const TABS: { id: Tab; label: string }[] = [
  { id: 'edit', label: 'Edit layout' },
  { id: 'widgets', label: 'Widgets' },
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
  const [tab, setTab] = useState<Tab>('edit')
  const [publishing, setPublishing] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  /**
   * Escape closes, Tab stays inside.
   *
   * Escape returns focus to the button that opened the dialog — otherwise a keyboard user is
   * dropped at the top of the document with no idea where they were.
   *
   * The trap is not optional decoration. `aria-modal="true"` tells a screen reader the rest of the
   * page is inert; it does nothing whatsoever about Tab. Without this, focus walks out of the
   * dialog and onto a board the user has just been told is not there, and the only way back is
   * shift-tabbing past everything they passed on the way out.
   */
  useEffect(() => {
    if (!open) return

    const focusable = (): HTMLElement[] => {
      const dialog = dialogRef.current
      if (dialog === null) return []
      return [
        ...dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
            'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
        // Hidden elements are still matched by the selector; a disabled-looking control that is
        // merely `display: none` would otherwise become a stop where nothing appears to happen.
      ].filter((element) => element.offsetParent !== null || element === document.activeElement)
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
        return
      }
      if (event.key !== 'Tab') return

      const stops = focusable()
      if (stops.length === 0) return
      const first = stops[0] as HTMLElement
      const last = stops[stops.length - 1] as HTMLElement
      const active = document.activeElement

      // Both directions. A trap that only wraps forwards sends the user out of the back of the
      // dialog the first time they shift-tab, which is the more common way to go looking for a
      // control you have just passed.
      if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
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
              {/* Publishing belongs next to the state it acts on — the "live" pill and the
                  unpublished-changes dot — rather than in a footer the panel has to be scrolled to
                  reach. It keeps its accessible name; only the label became a glyph. */}
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
            </footer>
          </div>
        </div>
      ) : null}
    </>
  )
}
