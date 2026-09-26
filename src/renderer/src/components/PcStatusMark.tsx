import type { PcState } from '../../../shared/protocol'
import { pcStateLabel } from '../lib/bots'

/** Same visual language as `TaskStatusMark`: a plain dot, colored by state, always paired with a label. */
export function PcStatusMark({ state }: { state: PcState }) {
  if (state === 'running') return <span className="mark-dot" style={{ background: 'var(--olive)' }} />
  if (state === 'starting') return <span className="mark-dot pulse-txt" style={{ background: 'var(--ink-muted)' }} />
  if (state === 'error') return <span className="mark-dot" style={{ background: 'var(--brick)' }} />
  return <span className="mark-dot" style={{ border: '1px solid var(--rule)' }} />
}

/** The dot plus its text label, for places that need the state spelled out (not just relying on color). */
export function PcStatusLine({ state }: { state: PcState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <PcStatusMark state={state} />
      <span>{pcStateLabel(state)}</span>
    </span>
  )
}
