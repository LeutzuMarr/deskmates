import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AssistantText } from './Markdown'
import { ActivityGroup } from './ActivityGroup'
import { ApprovalCard } from './ApprovalCard'
import { AgentCard, CARD_TOOLS, QuickReplyCard } from './AgentCards'
import { quickReplies } from '../../../shared/quick-replies'
import { BrandMark } from './Mascot'
import { CopyButton } from './CopyButton'
import { Thinking } from './Thinking'
import { ArrowDown } from 'lucide-react'
import { formatElapsed, awaitingFirstOutput } from '../lib/format'
import { WorkingLine, WorkingPill } from './Working'
import { currentActivity } from '../lib/steps'
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
  /** The message box (and anything shown with it), floated over the bottom of the conversation so
   *  messages scroll underneath its glass. The conversation leaves room for it at the end. */
  dock?: ReactNode
}

/** The user item that started the turn an assistant item belongs to. */
function turnStart(timeline: TimelineItem[], i: number): Extract<TimelineItem, { kind: 'user' }> | undefined {
  let k = i - 1
  while (k >= 0 && (timeline[k].kind === 'tool' || timeline[k].kind === 'thinking')) k--
  return k >= 0 && timeline[k].kind === 'user' ? (timeline[k] as Extract<TimelineItem, { kind: 'user' }>) : undefined
}

/** How long a finished reply took, from the prompt to the end of the reply. While the turn runs,
 *  the live count is the working row at the bottom instead. */
function ReplyTime({ startAt, doneAt }: { startAt: number; doneAt: number }) {
  return <span className="mb-1 block text-[12px] text-ink-faint">{formatElapsed(Math.max(0, doneAt - startAt))}</span>
}

/** Whether the assistant item at `i` closes its turn: only tool activity, if anything, follows before the next prompt. */
function closesTurn(timeline: TimelineItem[], i: number): boolean {
  for (let k = i + 1; k < timeline.length; k++) {
    if (timeline[k].kind === 'user') return true
    if (timeline[k].kind === 'assistant') return false
  }
  return true
}

/** Every assistant text of the turn that ends at `i`, in order, for copying the whole reply. */
function turnText(timeline: TimelineItem[], i: number): string {
  const parts: string[] = []
  for (let k = i; k >= 0 && timeline[k].kind !== 'user'; k--) {
    const item = timeline[k]
    if (item.kind === 'assistant') parts.unshift(item.text)
  }
  return parts.join('\n\n')
}

/** Renders a task's (or bot run's) timeline: user bubbles, assistant replies, collapsed tool activity and approval cards. */
export function Conversation({ taskId, mode = 'task', timeline, running, emptyHint, contentClassName, pill = true, starting = null, dock }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const [dockHeight, setDockHeight] = useState(0)

  // The dock grows with the message being typed; the conversation keeps that much room under its
  // last message, and stays pinned to the bottom when it was already there.
  useLayoutEffect(() => {
    const el = dockRef.current
    if (!el) {
      setDockHeight(0)
      return
    }
    const measure = (): void => setDockHeight(el.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [dock !== undefined])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [dockHeight])

  // Content can also grow after it is shown (a widget sizing itself, an image loading, a step
  // group opening): stay pinned to the bottom then too, so the latest message isn't left under
  // the dock.
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const content = contentRef.current
    const el = scrollRef.current
    if (!content || !el) return
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  const nearBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
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
  // The step the agent is on, written out live ("Reading src/app.ts…", "Analyzing example.com…").
  const activity = running ? currentActivity(timeline) : null

  const nodes: ReactNode[] = []
  let i = 0
  while (i < timeline.length) {
    const item = timeline[i]
    if (item.kind === 'user') {
      nodes.push(
        <div key={item.id} className="msg-row flex items-start justify-end gap-1">
          <CopyButton text={item.text} label="Copy message" className="msg-action mt-2.5" />
          <div className="user-bubble max-w-[75%] whitespace-pre-wrap">{item.text}</div>
        </div>
      )
      i++
      continue
    }
    if (item.kind === 'assistant') {
      // Thinking that came just before the reply doesn't count: the reply still opens the turn.
      let p = i - 1
      while (p >= 0 && timeline[p].kind === 'thinking') p--
      const previous = p >= 0 ? timeline[p] : undefined
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
      const finished = closesTurn(timeline, i) && !(running && (!started || started === timeline[lastUserIdx]))
      // The latest finished reply keeps its actions in view; earlier ones show them on hover.
      const isLast = finished && !timeline.slice(i + 1).some((later) => later.kind === 'user')
      const at = i
      nodes.push(
        <div key={item.id} className="msg-row flex gap-3">
          {firstOfTurn && (
            <div className="mt-1 shrink-0">
              <BrandMark size={20} working={running} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {firstOfTurn && replyTime}
            <AssistantText text={item.text} />
            {isLast && mode === 'task' && !running && i === timeline.length - 1 && (() => {
              const replies = quickReplies(item.text)
              return replies ? <QuickReplyCard key={item.id} taskId={taskId} replies={replies} running={running} /> : null
            })()}
            {finished && (
              <div className={`mt-1.5 flex items-center gap-1 ${isLast ? '' : 'msg-action'}`}>
                <CopyButton text={() => turnText(timeline, at)} label="Copy reply" showLabel />
              </div>
            )}
          </div>
        </div>
      )
      i++
      continue
    }
    if (item.kind === 'thinking') {
      const next = timeline[i + 1]
      nodes.push(
        <Thinking
          key={item.id}
          text={item.text}
          startedAt={item.at}
          endedAt={next ? next.at : null}
          live={running && i === timeline.length - 1}
        />
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
      {running && pill && <WorkingPill since={workingSince} label={activity ?? undefined} />}
      <div
        ref={scrollRef}
        className="scroll-area min-h-0 min-w-0 flex-1 overflow-y-auto"
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight
          nearBottomRef.current = distance < 160
          setShowJump(distance > 480)
        }}
      >
        <div
          ref={contentRef}
          className={`mx-auto flex w-full flex-col gap-4 ${contentClassName ?? 'max-w-[720px] px-8 py-6'} ${running && pill ? 'pt-14' : ''}`}
          style={dockHeight > 0 ? { paddingBottom: dockHeight + 8 } : undefined}
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
              label={silent ? (starting?.label ?? activity ?? undefined) : (activity ?? undefined)}
              hint={silent ? starting?.hint : undefined}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-latest"
          style={dockHeight > 0 ? { bottom: dockHeight + 4 } : undefined}
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
        >
          <ArrowDown size={15} aria-hidden="true" />
        </button>
      )}
      {dock !== undefined && (
        <div ref={dockRef} className="composer-dock">
          <div className={`mx-auto w-full ${contentClassName ? contentClassName.replace(/\bpy-\S+/g, '') : 'max-w-[720px] px-8'}`}>{dock}</div>
        </div>
      )}
    </div>
  )
}
