import { useId, useRef, useState, type ReactNode } from 'react'
import { useFocusTrap } from '../useFocusTrap.ts'

/**
 * Design panel entry point, bottom-right; the editor FAB is bottom-left so changing what the
 * dashboard shows and how it looks stay separate. `aria-modal` does nothing about Tab, hence the trap.
 */

export function DesignFab({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  useFocusTrap(open, dialogRef, () => {
    setOpen(false)
    buttonRef.current?.focus()
  })

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
        {/* SVG, not emoji: emoji colour and weight differ per platform. */}
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
