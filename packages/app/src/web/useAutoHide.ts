import { useEffect, useState } from 'react'

/**
 * Fades the floating controls when idle. Only opacity changes, and focus landing inside a control
 * wakes them, so the page stays tabbable. `prefers-reduced-motion` is handled by the CSS transition.
 */
export function useAutoHide(enabled: boolean, delayMs: number): boolean {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setHidden(false)
      return
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => setHidden(true), delayMs)
    }
    const wake = () => {
      setHidden(false)
      arm()
    }

    /** The two corners the controls live in, plus a margin wide enough to aim at. */
    const nearACorner = (event: PointerEvent) => {
      const reach = 180
      const nearBottom = event.clientY > window.innerHeight - reach
      const nearSide = event.clientX < reach || event.clientX > window.innerWidth - reach
      return nearBottom && nearSide
    }

    const onPointerMove = (event: PointerEvent) => {
      if (nearACorner(event)) wake()
    }
    const onKey = () => wake()
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('.nh-fab, .nh-modal') !== null)
        wake()
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    arm()

    return () => {
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [enabled, delayMs])

  return hidden
}
