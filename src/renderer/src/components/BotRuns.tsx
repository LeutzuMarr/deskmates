import { useEffect, useId, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { extractImageUrl, formatClock, formatDay, toolLabel } from '../lib/format'
import { CRON_PRESETS, runStateLabel } from '../lib/bots'
import { Conversation } from './Conversation'
import type { Bot, BotRun, RunState, Schedule, TimelineItem, ToolItem } from '../../../shared/protocol'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function RunStateMark({ state }: { state: RunState }) {
  if (state === 'running') return <span className="mark-dot pulse-txt" style={{ background: 'var(--ink-muted)' }} />
  if (state === 'waiting-approval') return <span className="mark-ring" />
  if (state === 'done') return <span className="mark-dot" style={{ background: 'var(--olive)' }} />
  if (state === 'error') return <span className="mark-dot" style={{ background: 'var(--brick)' }} />
  if (state === 'stopped') return <span className="mark-dot" style={{ border: '1px solid var(--rule)' }} />
  return <span className="mark-dot" style={{ border: '1px dashed var(--ink-faint)' }} />
}

export function BotRuns({ bot }: { bot: Bot }) {
  const runs = useStore((s) => s.runsByBot[bot.id]) ?? []
  const runItemsByRun = useStore((s) => s.runItemsByRun)
  const schedules = useStore((s) => s.schedulesByBot[bot.id]) ?? []
  const openRun = useStore((s) => s.openRun)
  const showToast = useStore((s) => s.showToast)

  const [taskText, setTaskText] = useState('')
  const [starting, setStarting] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const runTaskId = useId()

  useEffect(() => {
    if (selectedRunId) void openRun(selectedRunId)
  }, [selectedRunId, openRun])

  const runNow = async (): Promise<void> => {
    const task = taskText.trim()
    if (!task || starting) return
    setStarting(true)
    try {
      const run = await core.call('bots.run', { botId: bot.id, task })
      setTaskText('')
      setSelectedRunId(run.id)
    } catch (error) {
      showToast(`Couldn't start the run: ${errorMessage(error)}`)
    } finally {
      setStarting(false)
    }
  }

  const selectedRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : undefined

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="caption">Run now</h2>
        <div className="mt-3 rounded-3xl border border-rule bg-card p-2">
          <label className="sr-only" htmlFor={runTaskId}>
            What should the bot do?
          </label>
          <textarea
            id={runTaskId}
            rows={2}
            value={taskText}
            placeholder="What should the bot do right now?"
            onChange={(event) => setTaskText(event.target.value)}
            className="w-full resize-none bg-transparent text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className="btn btn-clay r-concentric"
              style={concentricVars(8)}
              disabled={!taskText.trim() || starting}
              onClick={() => void runNow()}
            >
              {starting ? 'Starting…' : 'Run now'}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2 className="caption">Runs</h2>
        {selectedRun ? (
          <RunDetail run={selectedRun} items={runItemsByRun[selectedRun.id] ?? []} onBack={() => setSelectedRunId(null)} />
        ) : (
          <div className="mt-3">
            {runs.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className="w-full rounded-3xl border border-rule bg-card px-5 py-4 text-left hover:bg-oat"
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="truncate text-[14px] text-ink">{run.task}</span>
                        <span className="shrink-0 text-[12px] text-ink-faint">
                          {formatDay(run.startedAt)} at {formatClock(run.startedAt)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <RunStateMark state={run.state} />
                        <span className="text-[12px] text-ink-muted">{runStateLabel(run.state)}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-faint">No runs yet — tell the bot what to do above, or add a schedule below.</p>
            )}
          </div>
        )}
      </section>

      <SchedulesSection bot={bot} schedules={schedules} />
    </div>
  )
}

function RunDetail({ run, items, onBack }: { run: BotRun; items: TimelineItem[]; onBack: () => void }) {
  return (
    <div className="mt-3">
      <button type="button" className="btn btn-text px-0 text-[13px]" onClick={onBack}>
        <ChevronLeft size={14} aria-hidden="true" className="mr-1 inline" />
        Back to runs
      </button>

      <div className="mt-3 flex items-baseline justify-between gap-4">
        <h3 className="truncate font-serif text-[18px] leading-snug">{run.task}</h3>
        <span className="shrink-0 text-[12px] text-ink-faint">
          {formatDay(run.startedAt)} at {formatClock(run.startedAt)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <RunStateMark state={run.state} />
        <span className="text-[12px] text-ink-muted">{runStateLabel(run.state)}</span>
      </div>
      {run.state === 'error' && run.error && (
        <div className="error-bar mt-3" role="alert">
          {run.error}
        </div>
      )}

      <div className="mt-4 flex h-[50vh] min-h-[300px] flex-col rounded-3xl border border-rule bg-card">
        <Conversation
          taskId={run.id}
          mode="run"
          timeline={items}
          running={run.state === 'running'}
          emptyHint="No activity recorded for this run yet."
          contentClassName="px-5 py-4"
        />
      </div>

      <div className="mt-4">
        <h3 className="caption">Screenshots</h3>
        <div className="mt-2">
          <RunScreenshots items={items} />
        </div>
      </div>
    </div>
  )
}

function RunScreenshots({ items }: { items: TimelineItem[] }) {
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => {
    if (!lightbox) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightbox])

  const shots = items
    .filter((item): item is ToolItem => item.kind === 'tool')
    .map((item) => ({ id: item.id, url: extractImageUrl(item.output), label: toolLabel(item.toolName, item.input) }))
    .filter((shot): shot is { id: string; url: string; label: string } => shot.url !== null)

  if (shots.length === 0) {
    return <p className="text-[13px] text-ink-faint">No screenshots in this run yet.</p>
  }

  return (
    <>
      <div className="grid grid-cols-4 gap-2">
        {shots.map((shot) => (
          <button
            key={shot.id}
            type="button"
            className="overflow-hidden rounded-xl border border-rule"
            aria-label={`Open screenshot: ${shot.label}`}
            onClick={() => setLightbox(shot.url)}
          >
            <img src={shot.url} alt={shot.label} className="aspect-video w-full object-cover" />
          </button>
        ))}
      </div>
      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ background: 'rgba(20, 20, 19, 0.75)' }}>
          <img src={lightbox} alt="Enlarged screenshot" className="max-h-full max-w-full rounded-xl" />
          <button type="button" className="btn btn-ivory absolute right-6 top-6" onClick={() => setLightbox(null)}>
            Close
          </button>
        </div>
      )}
    </>
  )
}

function SchedulesSection({ bot, schedules }: { bot: Bot; schedules: Schedule[] }) {
  const showToast = useStore((s) => s.showToast)
  const [cron, setCron] = useState('')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)

  const cronId = useId()
  const taskId = useId()

  const add = async (): Promise<void> => {
    const cronValue = cron.trim()
    const taskValue = task.trim()
    if (!cronValue || !taskValue) {
      showToast('Give the schedule a time (cron) and a task.')
      return
    }
    setBusy(true)
    try {
      await core.call('schedules.create', { botId: bot.id, cron: cronValue, task: taskValue })
      setCron('')
      setTask('')
    } catch (error) {
      showToast(`Couldn't add the schedule: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (schedule: Schedule): Promise<void> => {
    try {
      await core.call('schedules.update', { id: schedule.id, enabled: !schedule.enabled })
    } catch (error) {
      showToast(`Couldn't change the schedule: ${errorMessage(error)}`)
    }
  }

  const remove = async (schedule: Schedule): Promise<void> => {
    if (!window.confirm(`Delete this schedule ("${schedule.task}")?`)) return
    try {
      await core.call('schedules.delete', { id: schedule.id })
    } catch (error) {
      showToast(`Couldn't delete the schedule: ${errorMessage(error)}`)
    }
  }

  return (
    <section>
      <h2 className="caption">Schedule</h2>
      <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
        {schedules.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {schedules.map((schedule) => (
              <li key={schedule.id} className="flex items-start justify-between gap-3 border-b border-rule pb-3 last:border-b-0 last:pb-0">
                <div className="min-w-0">
                  <div className="font-mono text-[12px] text-ink-muted">{schedule.cron}</div>
                  <div className="truncate text-[13px] text-ink">{schedule.task}</div>
                  <div className="text-[12px] text-ink-faint">
                    {schedule.enabled ? 'On' : 'Off'}
                    {schedule.enabled && schedule.nextRunAt !== null
                      ? ` · next ${formatDay(schedule.nextRunAt)} at ${formatClock(schedule.nextRunAt)}`
                      : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" className="btn btn-text px-2 text-[12px]" onClick={() => void toggle(schedule)}>
                    {schedule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-text px-2 text-[12px]"
                    aria-label={`Delete schedule: ${schedule.task}`}
                    onClick={() => void remove(schedule)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-faint">No schedule yet — this bot only runs when you ask it to.</p>
        )}

        <div className="mt-3 flex flex-col gap-2 border-t border-rule pt-3">
          <div className="flex flex-wrap gap-3">
            {CRON_PRESETS.map((preset) => (
              <button key={preset.cron} type="button" className="btn btn-text px-0 text-[12px]" onClick={() => setCron(preset.cron)}>
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="field w-[160px]">
              <label className="field-label" htmlFor={cronId}>
                Cron (local time)
              </label>
              <input
                id={cronId}
                className="input font-mono"
                placeholder="0 8 * * *"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
              />
            </div>
            <div className="field min-w-[220px] flex-1">
              <label className="field-label" htmlFor={taskId}>
                What to do
              </label>
              <input
                id={taskId}
                className="input"
                placeholder="Open example.com and summarize today's posts"
                value={task}
                onChange={(event) => setTask(event.target.value)}
              />
            </div>
            <button type="button" className="btn btn-outline shrink-0" disabled={busy} onClick={() => void add()}>
              Add schedule
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
