import type { PcState } from '../../../shared/protocol'
import { pcStateLabel } from '../lib/bots'
import { StatusMark, pcMark } from './StatusMark'

export function PcStatusMark({ state, quietIdle }: { state: PcState; quietIdle?: boolean }) {
  return <StatusMark kind={pcMark(state)} quietIdle={quietIdle} />
}

/** The mark plus its text label, for places that need the state spelled out (not just relying on color). */
export function PcStatusLine({ state }: { state: PcState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <PcStatusMark state={state} />
      <span>{pcStateLabel(state)}</span>
    </span>
  )
}
