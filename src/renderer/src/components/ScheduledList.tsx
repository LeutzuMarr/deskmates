import { useState, type FormEvent, type ReactNode } from 'react'
import { CalendarClock, Play, Trash2 } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'
import { describeWhen, validateWhen, type Frequency, type When } from '../../../shared/when'
import type { TaskSchedule } from '../../../shared/protocol'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function nextLabel(schedule: TaskSchedule): string {
  if (!schedule.enabled) return 'Off'
  if (!schedule.nextRunAt) return 'Nothing scheduled'
  return `Next ${new Date(schedule.nextRunAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
}

async function act(promise: Promise<unknown>, onError: (message: string) => void): Promise<void> {
  try {
    await promise
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error))
  }
}

/** "Ready to run" cards: scheduled runs on a command-line model, waiting for the user's Start. */
export function PendingStarts({ projectId }: { projectId?: string }): ReactNode {
  const schedules = useStore((s) => s.taskSchedules)
  const projects = useStore((s) => s.projects)
  const showToast = useStore((s) => s.showToast)
  const navigate = useStore((s) => s.navigate)
  const waiting = schedules.filter((s) => s.pendingSince !== null && (!projectId || s.projectId === projectId))
  if (waiting.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {waiting.map((schedule) => {
        const project = projects.find((p) => p.id === schedule.projectId)
        return (
          <div key={schedule.id} className="msg-in flex items-center gap-3 rounded-3xl border border-clay/40 bg-card px-5 py-3">
            <CalendarClock size={18} className="shrink-0 text-clay" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-serif text-[16px]">Ready to run: {schedule.name}</div>
              <div className="text-[12px] text-ink-muted">
                {project ? `${project.name} · ` : ''}due {new Date(schedule.pendingSince!).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. It runs on a command-line model, so it waits for you.
              </div>
            </div>
            <button type="button" className="btn btn-text" onClick={() => void act(core.call('taskSchedules.dismiss', { id: schedule.id }), showToast)}>
              Skip
            </button>
            <button
              type="button"
              className="btn btn-clay r-concentric"
              style={concentricVars(14)}
              onClick={() =>
                void act(
                  core.call('taskSchedules.start', { id: schedule.id }).then((started) => {
                    if (started) navigate({ name: 'task', projectId: schedule.projectId, taskId: started.taskId })
                  }),
                  showToast
                )
              }
            >
              Start
            </button>
          </div>
        )
      })}
    </div>
  )
}

function NewScheduleForm({ projectId, onDone }: { projectId: string; onDone: () => void }): ReactNode {
  const showToast = useStore((s) => s.showToast)
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [frequency, setFrequency] = useState<Frequency>('weekdays')
  const [time, setTime] = useState('07:30')
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))
  const [days, setDays] = useState<number[]>([1])
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const when: When = {
    frequency,
    time,
    ...(frequency === 'once' ? { date } : {}),
    ...(frequency === 'weekly' ? { days } : {}),
    ...(frequency === 'monthly' ? { dayOfMonth } : {})
  }
  const problem = validateWhen(when)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (problem || !name.trim() || !instruction.trim()) return
    void act(core.call('taskSchedules.create', { projectId, name, instruction, when }).then(onDone), showToast)
  }

  const field = 'rounded-xl border border-rule bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted'
  return (
    <form className="mt-3 flex flex-col gap-2 rounded-3xl border border-rule bg-card p-4" onSubmit={submit}>
      <input className={field} placeholder="Name, like “Homework check”" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <textarea className={`${field} min-h-[72px] resize-y`} placeholder="What should run, complete on its own" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Instruction" />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <select className={field} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} aria-label="How often">
          <option value="once">Once</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday</option>
          <option value="weekly">Every week on…</option>
          <option value="monthly">Every month on day…</option>
        </select>
        {frequency === 'once' && <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}
        {frequency === 'monthly' && (
          <input type="number" min={1} max={31} className={`${field} w-20`} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} aria-label="Day of the month" />
        )}
        <span className="text-ink-muted">at</span>
        <input type="time" className={field} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
      </div>
      {frequency === 'weekly' && (
        <div className="flex flex-wrap gap-1">
          {DAYS.map((label, day) => (
            <button
              key={label}
              type="button"
              aria-pressed={days.includes(day)}
              className={`rounded-full border px-3 py-1 text-[12px] ${days.includes(day) ? 'border-ink bg-ink text-canvas' : 'border-rule text-ink-muted'}`}
              onClick={() => setDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day])}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-ink-muted">{problem ?? describeWhen(when)}</span>
        <div className="flex gap-2">
          <button type="button" className="btn btn-text" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="btn btn-ivory r-concentric" style={concentricVars(14)} disabled={Boolean(problem) || !name.trim() || !instruction.trim()}>
            Schedule
          </button>
        </div>
      </div>
    </form>
  )
}

/** The project page's "Scheduled" section: the project's scheduled tasks, and a form for a new one. */
export function ScheduledList({ projectId }: { projectId: string }): ReactNode {
  const schedules = useStore((s) => s.taskSchedules).filter((s) => s.projectId === projectId)
  const showToast = useStore((s) => s.showToast)
  const navigate = useStore((s) => s.navigate)
  const [adding, setAdding] = useState(false)
  return (
    <div className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="caption">Scheduled</h2>
        {!adding && (
          <button type="button" className="btn btn-text" onClick={() => setAdding(true)}>
            New scheduled task
          </button>
        )}
      </div>
      <div className="mt-3">
        <PendingStarts projectId={projectId} />
      </div>
      {adding && <NewScheduleForm projectId={projectId} onDone={() => setAdding(false)} />}
      {schedules.length === 0 && !adding ? (
        <p className="mt-3 text-[13px] text-ink-faint">Nothing scheduled. Ask the assistant (“every weekday at 7:30, check…”) or add one here.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="flex items-center gap-3 rounded-3xl border border-rule bg-card px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-serif text-[16px]">{schedule.name}</div>
                <div className="text-[12px] text-ink-muted">
                  {describeWhen(schedule.when)} · {nextLabel(schedule)}
                  {schedule.lastTaskId && (
                    <>
                      {' · '}
                      <button type="button" className="underline" onClick={() => navigate({ name: 'task', projectId, taskId: schedule.lastTaskId! })}>
                        last run
                      </button>
                    </>
                  )}
                </div>
              </div>
              <label className="flex items-center gap-1 text-[12px] text-ink-muted">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={schedule.enabled}
                  onChange={(e) => void act(core.call('taskSchedules.update', { id: schedule.id, enabled: e.target.checked }), showToast)}
                />
                On
              </label>
              <button
                type="button"
                className="btn-icon"
                aria-label={`Run ${schedule.name} now`}
                title="Run now"
                onClick={() =>
                  void act(
                    core.call('taskSchedules.runNow', { id: schedule.id }).then(({ taskId }) => navigate({ name: 'task', projectId, taskId })),
                    showToast
                  )
                }
              >
                <Play size={15} />
              </button>
              <button
                type="button"
                className="btn-icon"
                aria-label={`Delete ${schedule.name}`}
                title="Delete"
                onClick={() => {
                  if (window.confirm(`Delete the scheduled task “${schedule.name}”?`)) void act(core.call('taskSchedules.delete', { id: schedule.id }), showToast)
                }}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
