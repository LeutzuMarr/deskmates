import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AssistantText } from './Markdown'
import { ActivityGroup } from './ActivityGroup'
import { ApprovalCard } from './ApprovalCard'
import { AgentCard, CARD_TOOLS } from './AgentCards'
import { BrandMark } from './Mascot'
import { formatElapsed, awaitingFirstOutput } from '../lib/format'
import { WorkingLine, WorkingPill } from './Working'
import type { StartingNotice } from '../lib/format'
import type { TimelineItem, ToolItem } from '../../../shared/protocol'

interface ConversationProps {
  /** A task id in 'task' mode (the default), a bot run id in 'run' mode. */
  taskId: string
  /** Which id space `taskId` is from, and so which RPC method an approval card answers through. Defaults to 'task' so the Work tab and Design tab (which only ever show tasks) don't need to pass it. */
  mode?: 'task' | 'run'
  timeline: TimelineItem[]
  /** Whether the task is currently running (pulses the brand mark and the empty-state mark). */
  running: boolean
  /** Shown centered when the timeline is empty. */
  emptyHint: string
  /** Classes for the scrolled content column; defaults to the Work tab's width and padding. */
  contentClassName?: string
  /** Show the floating "working" popup while running. The Design tab shows its own over the preview. */
  pill?: boolean
  /** Replaces the working row's rotating verb while the run is up but silent, for providers whose
   *  start-up is long enough that a timer over an empty transcript reads as a freeze. */
  starting?: StartingNotice | null
}

/** The user item that started the turn an assistant item belongs to. */
function turnStart(timeline: TimelineItem[], i: number): Extract<TimelineItem, { kind: 'user' }> | undefined {
  let k = i - 1
  while (k >= 0 && timeline[k].kind === 'tool') k--
  return k >= 0 && timeline[k].kind === 'user' ? (timeline[k] as Extract<TimelineItem, { kind: 'user' }>) : undefined
}

/** How long a finished reply took, from the prompt to the end of the reply. While the turn runs,
 *  the live count is the working row at the bottom instead. */
function ReplyTime({ startAt, doneAt }: { startAt: number; doneAt: number }) {
  return <span className="mb-1 block text-[12px] text-ink-faint">{formatElapsed(Math.max(0, doneAt - startAt))}</span>
}

/** Renders a task's (or bot run's) timeline: user bubbles, assistant replies, collapsed tool activity and approval cards. */
export function Conversation({ taskId, mode = 'task', timeline, running, emptyHint, contentClassName, pill = true, starting = null }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  // For a run that started without a prompt in this timeline (e.g. a scheduled bot run).
  const [runningSince, setRunningSince] = useState<number | null>(null)

  useEffect(() => {
    setRunningSince(running ? Date.now() : null)
  }, [running])

  useEffect(() => {
    if (nearBottomRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [timeline.length, timeline.at(-1)?.id, running])

  let lastUserIdx = -1
  for (let k = 0; k < timeline.length; k++) if (timeline[k].kind === 'user') lastUserIdx = k
  const workingSince = running ? (lastUserIdx >= 0 ? timeline[lastUserIdx].at : runningSince) : null
  // True only during start-up; once the reply starts arriving the working row goes back to its
  // rotating verb, which no longer has anything to disclaim.
  const silent = running && awaitingFirstOutput(timeline, running)

  const nodes: ReactNode[] = []
  let i = 0
  while (i < timeline.length) {
    const item = timeline[i]
    if (item.kind === 'user') {
      nodes.push(
        <div key={item.id} className="flex justify-end">
          <div className="user-bubble max-w-[75%] whitespace-pre-wrap">{item.text}</div>
        </div>
      )
      i++
      continue
    }
    if (item.kind === 'assistant') {
      const previous = i > 0 ? timeline[i - 1] : undefined
      const firstOfTurn = !previous || previous.kind === 'user'
      const started = turnStart(timeline, i)
      let doneAt: number | null = null
      if (started) {
        if (running && started === timeline[lastUserIdx]) {
          doneAt = null
        } else {
          let j = i
          while (j + 1 < timeline.length && timeline[j + 1].kind !== 'user') j++
          doneAt = Math.max(started.at, timeline[j].at)
        }
      }
      const replyTime = started && doneAt !== null ? <ReplyTime startAt={started.at} doneAt={doneAt} /> : null
      nodes.push(
        <div key={item.id} className="flex gap-3">
          {firstOfTurn && (
            <div className="mt-1 shrink-0">
              <BrandMark size={20} working={running} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {firstOfTurn && replyTime}
            <AssistantText text={item.text} />
          </div>
        </div>
      )
      i++
      continue
    }
    if (CARD_TOOLS.has(item.toolName)) {
      const answered = timeline.slice(i + 1).some((later) => later.kind === 'user')
      nodes.push(
        <div key={item.id} className="min-w-0">
          <AgentCard taskId={taskId} item={item} answered={answered || mode !== 'task'} running={running} />
        </div>
      )
      i++
      continue
    }
    if (item.state === 'awaiting-approval') {
      nodes.push(<ApprovalCard key={item.id} mode={mode} id={taskId} item={item} />)
      i++
      continue
    }
    const group: TimelineItem[] = []
    while (i < timeline.length) {
      const current = timeline[i]
      if (current.kind !== 'tool' || current.state === 'awaiting-approval' || CARD_TOOLS.has(current.toolName)) break
      group.push(current)
      i++
    }
    if (group.length > 0) {
      const first = group[0] as Extract<TimelineItem, { kind: 'tool' }>
      nodes.push(<ActivityGroup key={first.id} items={group as ToolItem[]} />)
    }
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {running && pill && <WorkingPill since={workingSince} />}
      <div
        ref={scrollRef}
        className="scroll-area min-h-0 min-w-0 flex-1 overflow-y-auto"
        onScroll={() => {
          const el = scrollRef.current
          if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160
        }}
      >
        <div
          className={`mx-auto flex w-full flex-col gap-4 ${contentClassName ?? 'max-w-[720px] px-8 py-6'} ${running && pill ? 'pt-14' : ''}`}
        >
          {timeline.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <BrandMark size={40} working={running} />
              <p className="max-w-[360px] text-[14px] text-ink-muted">{emptyHint}</p>
            </div>
          )}
          {nodes}
          {running && (
            <WorkingLine
              since={workingSince}
              label={silent ? starting?.label : undefined}
              hint={silent ? starting?.hint : undefined}
            />
          )}
        </div>
      </div>
    </div>
  )
}
