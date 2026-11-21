import type { PlanItem } from '../../../shared/protocol'

/**
 * The agent's task list, at the end of the chat above the message box: a turning arc on the step
 * it is on, dashed rings for the ones ahead, checks for the ones done. Shared by every chat.
 */
export function PlanCard({ plan }: { plan: PlanItem[] }) {
  if (plan.length === 0) return null
  return (
    <div className="mb-3 rounded-2xl border border-rule bg-card px-4 py-3" aria-label="Task list">
      <ul className="flex flex-col gap-2">
        {plan.map((item, index) => (
          <PlanRow key={`${item.text}-${index}`} item={item} />
        ))}
      </ul>
    </div>
  )
}

export function PlanRow({ item }: { item: PlanItem }) {
  // The step being worked on stands out; the ones ahead and behind sit back, as in Claude's task list.
  const tone = item.status === 'in_progress' ? 'text-ink' : 'text-ink-muted'
  return (
    <li className={`flex items-start gap-2.5 text-[14px] leading-snug ${tone}`}>
      <span className="mt-[3px]">
        <PlanMark status={item.status} />
      </span>
      <span className="whitespace-pre-wrap">{item.text}</span>
      <span className="sr-only">{item.status === 'done' ? ' (done)' : item.status === 'in_progress' ? ' (in progress)' : ' (to do)'}</span>
    </li>
  )
}

function PlanMark({ status }: { status: PlanItem['status'] }) {
  if (status === 'done') return <span className="plan-mark plan-done" aria-hidden="true" />
  if (status === 'in_progress') return <span className="plan-mark plan-mark-active" aria-hidden="true" />
  return <span className="plan-mark plan-pending" aria-hidden="true" />
}
