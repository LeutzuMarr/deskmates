import { useStore } from '../lib/store'
import { formatClock, formatDay } from '../lib/format'
import { handoffStateLabel } from '../lib/bots'
import type { HandoffState } from '../../../shared/protocol'

function HandoffStateMark({ state }: { state: HandoffState }) {
  if (state === 'running') return <span className="mark-dot pulse-txt" style={{ background: 'var(--ink-muted)' }} />
  if (state === 'done') return <span className="mark-dot" style={{ background: 'var(--olive)' }} />
  if (state === 'error') return <span className="mark-dot" style={{ background: 'var(--brick)' }} />
  return <span className="mark-dot" style={{ border: '1px dashed var(--ink-faint)' }} />
}

export function HandoffsPanel() {
  const handoffs = useStore((s) => s.handoffs)
  const bots = useStore((s) => s.bots)
  const botNames: Record<string, string> = {}
  for (const bot of bots) botNames[bot.id] = bot.name

  return (
    <section>
      <h2 className="caption">Incoming handoffs</h2>
      <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
        {handoffs.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {handoffs.map((handoff) => {
              const toName = botNames[handoff.toBotId] ?? handoff.toBotId
              const fromName =
                handoff.fromBotId === 'sender' ? 'You' : botNames[handoff.fromBotId] ?? handoff.fromBotId
              const received = `${formatDay(handoff.createdAt)} at ${formatClock(handoff.createdAt)}`
              return (
                <li
                  key={handoff.id}
                  className="flex items-start justify-between gap-3 border-b border-rule pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-ink">{handoff.task}</div>
                    <div className="mt-1 text-[12px] text-ink-faint">
                      {fromName} to {toName} · {received}
                      {handoff.files.length > 0
                        ? ` · ${handoff.files.length} file${handoff.files.length === 1 ? '' : 's'}`
                        : ''}
                    </div>
                    {handoff.state !== 'pending' && handoff.state !== 'running' && (
                      <div className="mt-1 truncate text-[12px] text-ink-muted">{handoff.result}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <HandoffStateMark state={handoff.state} />
                    <span className="text-[12px] text-ink-muted">{handoffStateLabel(handoff.state)}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-faint">
            No handoffs yet — when another bot hands a task to one of your bots, it lands here.
          </p>
        )}
      </div>
    </section>
  )
}