import type { AttachedTerminalState, TerminalSessionState } from '../../../shared/protocol'
import { sessionStateLabel } from '../lib/terminals'

type StatusState = TerminalSessionState | AttachedTerminalState

/** Same visual language as `PcStatusMark`/`TaskStatusMark`: a plain dot, colored by state. */
export function TerminalStatusMark({ state }: { state: StatusState }) {
  if (state === 'idle' || state === 'connected') return <span className="mark-dot" style={{ background: 'var(--olive)' }} />
  if (state === 'busy' || state === 'starting' || state === 'priming' || state === 'attaching')
    return <span className="mark-dot pulse-txt" style={{ background: 'var(--ink-muted)' }} />
  if (state === 'closed') return <span className="mark-dot" style={{ background: 'var(--ink-faint)' }} />
  return <span className="mark-dot" style={{ background: 'var(--brick)' }} />
}

export function TerminalStatusLine({ state }: { state: TerminalSessionState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TerminalStatusMark state={state} />
      <span>{sessionStateLabel(state)}</span>
    </span>
  )
}