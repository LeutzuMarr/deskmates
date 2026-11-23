import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useLiquid } from './liquid'

/** A glass sheet that rises from the bottom on narrow screens and floats in the middle on wide ones. */
export function Sheet({ title, onClose, children, width = 520 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useLiquid(ref, { reach: 12, press: 0.01, axis: 'y' })
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 sm:items-center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-label={title}
        className="glass m-3 max-h-[88vh] w-full overflow-y-auto rounded-[30px] p-5 shadow-2xl"
        style={{ maxWidth: width, animation: 'sheet-up .38s cubic-bezier(.2,.9,.3,1.15)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-serif text-[24px] leading-tight">{title}</h2>
          <button type="button" aria-label="Close" className="press rounded-full bg-black/5 p-2 dark:bg-white/10" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Asks for a name (new folder, rename…). */
export function NameSheet({ title, initial = '', placeholder, action, onDone, onClose }: { title: string; initial?: string; placeholder?: string; action: string; onDone: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  return (
    <Sheet title={title} onClose={onClose} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onDone(name.trim())
        }}
      >
        <input ref={input} value={name} placeholder={placeholder} maxLength={80} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl border border-rule bg-card px-3 py-2.5 text-[16px] outline-none focus:border-clay" />
        <button type="submit" disabled={!name.trim()} className="press mt-4 w-full rounded-full bg-clay py-3 text-[15px] font-semibold text-white disabled:opacity-40">
          {action}
        </button>
      </form>
    </Sheet>
  )
}
