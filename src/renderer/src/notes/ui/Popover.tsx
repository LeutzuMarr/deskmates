import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLiquid } from './liquid'

/** A glass card that opens under a toolbar button and closes on a tap outside it. */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  width = 320,
  label
}: {
  open: boolean
  onClose: () => void
  anchor: { x: number; y: number } | null
  children: ReactNode
  width?: number
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLiquid(ref, { reach: 10, press: 0.012 })
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // Next tick, so the tap that opened it doesn't close it.
    const timer = setTimeout(() => window.addEventListener('pointerdown', away, true))
    window.addEventListener('keydown', key)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
    }
  }, [open, onClose])
  if (!open || !anchor) return null
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.x - width / 2))
  // Into <body>: inside a liquid bar, the bar's transform would become this card's frame.
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className="glass fixed z-50 rounded-[26px] p-4 shadow-2xl"
      style={{ left, top: anchor.y + 10, width, animation: 'pop-in .26s cubic-bezier(.25,.1,.25,1)', transformOrigin: 'top center' }}
    >
      {children}
    </div>,
    document.body
  )
}

/** Where a button is, for anchoring a popover under it. */
export function anchorOf(el: Element | null): { x: number; y: number } | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.bottom }
}
