import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { formatElapsed } from '../lib/format'

/**
 * The model's reasoning, the way Claude, Gemini and Grok show it: while it streams, a live
 * "Thinking" header over the last few lines scrolling past; afterwards a quiet "Thought for 12s"
 * line that opens to the full text.
 */
export function Thinking({ text, startedAt, endedAt, live }: { text: string; startedAt: number; endedAt: number | null; live: boolean }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const tailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  useEffect(() => {
    const el = tailRef.current
    if (live && el) el.scrollTop = el.scrollHeight
  }, [text, live])

  const elapsed = Math.max(0, (live ? now : (endedAt ?? startedAt)) - startedAt)

  if (live) {
    return (
      <div className="thinking msg-in" aria-live="polite">
        <div className="flex items-center gap-2 text-[14px]">
          <Sparkles size={14} aria-hidden="true" className="thinking-spark" />
          <span className="shimmer-txt font-medium">Thinking</span>
          <span className="text-[12px] tabular-nums text-ink-faint">{formatElapsed(elapsed)}</span>
        </div>
        <div ref={tailRef} className="thinking-tail">
          {text}
        </div>
      </div>
    )
  }

  return (
    <div className="thinking msg-in">
      <button
        type="button"
        className="activity-line"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <span>{elapsed >= 1000 ? `Thought for ${formatElapsed(elapsed)}` : 'Thought process'}</span>
      </button>
      {open && <div className="thinking-full">{text}</div>}
    </div>
  )
}
