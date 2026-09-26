import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../lib/store'

export function Toast() {
  const toast = useStore((s) => s.toast)
  const clearToast = useStore((s) => s.clearToast)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(clearToast, 7000)
    return () => clearTimeout(timer)
  }, [toast, clearToast])

  if (!toast) return null
  return (
    <div className="toast" role="alert">
      <span className="min-w-0 flex-1 break-words self-center">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="btn btn-text shrink-0 px-2 text-[13px]"
          onClick={() => {
            toast.action?.onClick()
            clearToast()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="btn-icon shrink-0" aria-label="Dismiss" onClick={clearToast}>
        <X size={16} />
      </button>
    </div>
  )
}