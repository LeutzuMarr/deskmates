import type { TaskStatus } from '../../../shared/protocol'

export function TaskStatusMark({ status }: { status: TaskStatus }) {
  if (status === 'running') return <span className="mark-dot pulse-txt" style={{ background: 'var(--ink-muted)' }} />
  if (status === 'waiting-approval') return <span className="mark-ring" />
  if (status === 'error') return <span className="mark-dot" style={{ background: 'var(--brick)' }} />
  return <span className="mark-dot" style={{ border: '1px solid var(--rule)' }} />
}