import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * The design entry point: a button in the bottom-right corner.
 *
 * The editor FAB deliberately sits bottom-LEFT, because the right corner is where chat widgets and
 * cookie banners live. Two corners is the point: the left one changes what the dashboard SAYS —
 * widgets, layout, services — and this one changes how it LOOKS. Those are different jobs done at
 * different times, and putting them in one modal made the theme controls something you found by
 * accident while adding a service.
 *
 * The focus trap is the same shape as the editor's, and for the same reason: `aria-modal` tells a
 * screen reader the rest of the page is inert and does precisely nothing about Tab.
 */

export function DesignFab({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="nh-fab nh-fab-design"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {/* An SVG rather than an emoji: an emoji is a font-dependent picture of an icon, and it
            renders as a different colour and weight on every platform. */}
        <svg
          className="nh-fab-icon"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.4-3.4 2 2 0 0 1 1.4-3.4H18a3 3 0 0 0 3-3 9 9 0 0 0-9-8.2Z" />
          <circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="10.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="8" r="1.1" fill="currentColor" stroke="none" />
        </svg>
        <span className="nh-sr-only">Open the design panel</span>
      </button>

      {open ? (
        <div className="nh-modal-scrim" onClick={() => setOpen(false)}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="nh-modal nh-modal-right"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="nh-modal-head">
              <h2 id={titleId} className="nh-modal-title">
                Design
              </h2>
              <button type="button" className="nh-modal-close" onClick={() => setOpen(false)}>
                <span className="nh-sr-only">Close</span>
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <div className="nh-modal-body nh-modal-body-plain">
              {children(() => setOpen(false))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
