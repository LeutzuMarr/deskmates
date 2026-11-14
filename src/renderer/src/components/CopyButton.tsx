import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** Copies text to the clipboard and shows a check for a moment. `text` may be read lazily at click time. */
export function CopyButton({
  text,
  label = 'Copy',
  showLabel = false,
  className = ''
}: {
  text: string | (() => string)
  label?: string
  showLabel?: boolean
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
      setCopied(true)
    } catch {
      // Clipboard access can be refused; nothing useful to show beyond not ticking.
    }
  }

  return (
    <button
      type="button"
      className={`copy-btn ${className}`}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => void copy()}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {showLabel && <span>{copied ? 'Copied' : 'Copy'}</span>}
    </button>
  )
}
