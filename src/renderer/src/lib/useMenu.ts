import { useEffect, useRef } from 'react'

/** Closes an open menu on an outside pointer-down or Escape. Attach the returned ref to the menu's outermost element. */
export function useDismissableMenu<T extends HTMLElement>(open: boolean, onClose: () => void): React.RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  return ref
}
