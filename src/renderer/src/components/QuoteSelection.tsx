import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { Quote } from 'lucide-react'
import { QUOTE_EVENT, quoted } from '../lib/quote'

/**
 * Select words in a reply and a "Quote" button appears by them, as in Claude: it puts the words in
 * the message box as a quote, so the next message can ask about exactly that part.
 */
export function QuoteSelection({ root }: { root: RefObject<HTMLElement | null> }) {
  const [spot, setSpot] = useState<{ x: number; y: number; text: string } | null>(null)
  useEffect(() => {
    const update = (): void => {
      const selection = window.getSelection()
      const text = selection?.toString() ?? ''
      if (!selection || selection.rangeCount === 0 || !text.trim() || !root.current) {
        setSpot(null)
        return
      }
      const range = selection.getRangeAt(0)
      const node = range.commonAncestorContainer
      const element = node instanceof Element ? node : node.parentElement
      // Only the agent's replies, inside this conversation.
      if (!element || !root.current.contains(element) || !element.closest('.markdown')) {
        setSpot(null)
        return
      }
      const rect = range.getBoundingClientRect()
      setSpot({ x: Math.min(window.innerWidth - 90, Math.max(8, rect.left + rect.width / 2 - 40)), y: Math.max(8, rect.top - 40), text })
    }
    const onUp = (): void => {
      window.setTimeout(update, 0)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keyup', onUp)
    const scroller = root.current
    const hide = (): void => setSpot(null)
    scroller?.addEventListener('scroll', hide, { passive: true })
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keyup', onUp)
      scroller?.removeEventListener('scroll', hide)
    }
  }, [root])
  if (!spot) return null
  return (
    <button
      type="button"
      className="quote-btn"
      style={{ left: spot.x, top: spot.y }}
      // Keep the selection while pressing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        window.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: quoted(spot.text) }))
        window.getSelection()?.removeAllRanges()
        setSpot(null)
      }}
    >
      <Quote size={13} aria-hidden="true" />
      Quote
    </button>
  )
}
