import { TriangleAlert } from 'lucide-react'
import type { AttachedTerminalState, PcState, TaskStatus, TerminalSessionState } from '../../../shared/protocol'

/**
 * The one set of status marks every list in the app uses:
 * - `working`   a small turning ring: an agent is busy right now
 * - `attention` a clay ring: it is waiting for the user (an approval, a question)
 * - `problem`   a warning triangle: the last run ended in an error
 * - `unread`    a dot: it finished while the user was looking elsewhere
 * - `ok`        an olive dot: connected and ready
 * - `off`       a faint dot: closed or detached
 * - `idle`      nothing to report
 */
export type MarkKind = 'working' | 'attention' | 'problem' | 'unread' | 'ok' | 'off' | 'idle'

const LABELS: Record<MarkKind, string> = {
  working: 'Working',
  attention: 'Waiting for you',
  problem: 'Something went wrong',
  unread: 'Finished',
  ok: 'Ready',
  off: 'Closed',
  idle: 'Idle'
}

/** When several things sit behind one row (a collapsed group), the mark that matters most wins. */
const PRIORITY: MarkKind[] = ['attention', 'problem', 'working', 'unread', 'ok', 'off', 'idle']

export function strongestMark(kinds: MarkKind[]): MarkKind {
  return PRIORITY.find((kind) => kinds.includes(kind)) ?? 'idle'
}

export function taskMark(status: TaskStatus, unread = false): MarkKind {
  if (status === 'running') return 'working'
  if (status === 'waiting-approval') return 'attention'
  if (status === 'error') return 'problem'
  return unread ? 'unread' : 'idle'
}

export function terminalMark(state: TerminalSessionState | AttachedTerminalState, unread = false): MarkKind {
  if (state === 'busy' || state === 'starting' || state === 'priming' || state === 'attaching') return 'working'
  if (state === 'error') return 'problem'
  if (state === 'closed') return 'off'
  return unread ? 'unread' : 'ok'
}

export function pcMark(state: PcState): MarkKind {
  if (state === 'running') return 'ok'
  if (state === 'starting') return 'working'
  if (state === 'error') return 'problem'
  return 'idle'
}

interface StatusMarkProps {
  kind: MarkKind
  /** In a list where most rows are idle, an idle row shows nothing. Next to a text label it keeps a hollow dot. */
  quietIdle?: boolean
}

export function StatusMark({ kind, quietIdle = false }: StatusMarkProps) {
  if (kind === 'idle' && quietIdle) return null
  const label = LABELS[kind]
  if (kind === 'working') {
    return (
      <span className="mark mark-working" role="img" aria-label={label} title={label}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle className="mark-working-track" cx="8" cy="8" r="6" />
          <circle className="mark-working-arc" cx="8" cy="8" r="6" />
        </svg>
      </span>
    )
  }
  if (kind === 'problem') {
    return (
      <span className="mark mark-problem" role="img" aria-label={label} title={label}>
        <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  return <span className={`mark mark-${kind}`} role="img" aria-label={label} title={label} />
}
