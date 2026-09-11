import { useEffect, useEffectEvent, type RefObject } from 'react'

/**
 * Traps Tab inside an open dialog and closes it on Escape; `aria-modal` alone does not stop Tab.
 * `onClose` goes through an effect event so an inline handler cannot re-run the effect and
 * re-focus the dialog while the user is typing in it.
 */
export function useFocusTrap(
  open: boolean,
  dialogRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
): void {
  const close = useEffectEvent(onClose)

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
        close()
        return
      }
      if (event.key !== 'Tab') return

      const stops = focusable()
      const first = stops.at(0)
      const last = stops.at(-1)
      if (first === undefined || last === undefined) return
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
}
