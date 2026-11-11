import type { AttachedTerminalState, TerminalSessionState } from '../../../shared/protocol'
import { sessionStateLabel } from '../lib/terminals'
import { StatusMark, terminalMark } from './StatusMark'

type StatusState = TerminalSessionState | AttachedTerminalState

export function TerminalStatusMark({ state, unread }: { state: StatusState; unread?: boolean }) {
  return <StatusMark kind={terminalMark(state, unread)} />
}

export function TerminalStatusLine({ state }: { state: TerminalSessionState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TerminalStatusMark state={state} />
      <span>{sessionStateLabel(state)}</span>
    </span>
  )
}
