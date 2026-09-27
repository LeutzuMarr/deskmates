import { useEffect, useRef, useState } from 'react'
import { formatElapsed } from '../lib/format'

const SPARK_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const VERBS = ['Thinking', 'Working', 'Pondering', 'Tinkering', 'Brewing', 'Crafting', 'Mulling', 'Noodling', 'Cooking', 'Puzzling']
const VERB_MS = 4000

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Re-renders every `ms` while mounted, so a live timer or animation frame keeps moving. */
function useTick(ms: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
  return tick
}

/** Milliseconds since `since`, or since this component mounted when no start time is known. */
function useElapsed(since: number | null | undefined): number {
  const mountedAt = useRef(Date.now())
  useTick(100)
  return Math.max(0, Date.now() - (since ?? mountedAt.current))
}

/** The turning spark shown while an agent works. */
export function WorkingSpark({ className = '' }: { className?: string }) {
  const tick = useTick(120)
  const frame = prefersReducedMotion() ? '✻' : SPARK_FRAMES[tick % SPARK_FRAMES.length]
  return (
    <span className={`working-spark ${className}`} aria-hidden="true">
      {frame}
    </span>
  )
}

/** A shimmering verb that changes every few seconds, like "Pondering…". */
function WorkingVerb() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * VERBS.length))
  useEffect(() => {
    const timer = setInterval(() => setIndex((i) => (i + 1 + Math.floor(Math.random() * (VERBS.length - 1))) % VERBS.length), VERB_MS)
    return () => clearInterval(timer)
  }, [])
  return <span className="shimmer-txt">{VERBS[index]}…</span>
}

/** The live "working" row at the bottom of a conversation, counting from the moment the prompt was sent.
 *
 *  `label` replaces the rotating verb for as long as something more specific is true of the run — the
 *  CLI's cold start, say, which is long enough and empty enough that a whimsical "Pondering…" reads
 *  as a freeze rather than as progress. */
export function WorkingLine({ since, label, hint }: { since: number | null; label?: string; hint?: string }) {
  const elapsed = useElapsed(since)
  return (
    <div className="msg-in flex items-start gap-2 text-[13px]" role="status" aria-live="polite">
      <WorkingSpark />
      {/* Text in its own column so a second line hangs off the label rather than needing a magic
          indent to line up with the spark. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {label ? <span className="shimmer-txt">{label}</span> : <WorkingVerb />}
          <span className="tabular-nums text-ink-faint">{formatElapsed(elapsed)}</span>
        </div>
        {hint && <p className="mt-0.5 text-[12px] text-ink-faint">{hint}</p>}
      </div>
    </div>
  )
}

/** The floating "working" popup shown over a view while its agent runs. */
export function WorkingPill({ since, label = 'The assistant is working…' }: { since?: number | null; label?: string }) {
  const elapsed = useElapsed(since)
  return (
    <div className="pill working-pill absolute left-1/2 top-3 z-10 -translate-x-1/2" role="status">
      <WorkingSpark />
      <span>{label}</span>
      <span className="tabular-nums text-ink-faint">{formatElapsed(elapsed)}</span>
    </div>
  )
}
