import { useStore } from '../lib/store'

const short = (tokens: number): string => (tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens))

/**
 * How full the model's context is, as a small ring by the message box (Claude Code shows the same).
 * Hidden until the task has taken a step; amber past 70%, red past 90%, when older turns start to
 * be left out.
 */
export function ContextMeter({ taskId }: { taskId?: string }) {
  const context = useStore((s) => (taskId ? s.contexts[taskId] : undefined))
  if (!context || context.window <= 0) return null
  const share = Math.min(1, context.used / context.window)
  const percent = Math.round(share * 100)
  // Under 1% says nothing worth the space.
  if (percent < 1) return null
  const tone = share > 0.9 ? 'var(--brick)' : share > 0.7 ? 'var(--clay)' : 'var(--ink-muted)'
  const r = 6
  const circumference = 2 * Math.PI * r
  const label = `${percent}% of the model's context used (${short(context.used)} of ${short(context.window)} tokens)${share > 0.7 ? '. Older messages will be left out soon; /clear starts fresh.' : ''}`
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-faint" title={label} aria-label={label} role="img">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--rule)" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${circumference * share} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span style={{ color: share > 0.7 ? tone : undefined }}>{percent}%</span>
    </span>
  )
}
