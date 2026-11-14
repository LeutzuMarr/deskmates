/**
 * Runs the scheduled tasks of Work and Design projects ("every weekday at 07:30, check…").
 *
 * At a task's time, on a model Deskmates calls itself (an API key), it creates a new task in the
 * project, sends the instruction and lets it run, approvals and all. On a model that is a
 * command-line tool (Freebuff, OpenCode, Antigravity) it never starts by itself: typing prompts into
 * someone else's tool on a timer is automated use those tools forbid. Instead the task waits for the
 * user's Start tap (`pendingSince`), shown on the PC and on the phone, and one tap runs it once.
 */
import type { Project, TaskSchedule, When } from '../../shared/protocol'
import { describeWhen, validateWhen } from '../../shared/when'
import type { EventBus } from '../events'
import type { Repos } from '../store/repos'
import { nextOccurrence } from './when'

/** A run counts as missed (the PC was off or asleep) when it is this late. */
const MISSED_AFTER_MS = 5 * 60_000

export interface TaskSchedulerDeps {
  repos: Repos
  bus: EventBus
  /** Sends a message to a task, starting its run (TaskRunner.send). */
  send: (taskId: string, text: string) => Promise<void>
  /** Resolves when the task's run is over (TaskRunner.whenIdle). */
  whenIdle: (taskId: string) => Promise<void>
  isRunning: (taskId: string) => boolean
  /** Whether this project's model is a command-line tool (Freebuff, OpenCode, Antigravity). */
  isCliProject: (project: Project) => boolean
  /** Windows wake timers, so a sleeping PC wakes for a run. Optional (tests, other OSes). */
  wake?: { upsert(id: string, nextMs: number): Promise<void>; remove(id: string): Promise<void> }
  notify: (title: string, body: string) => void
  now?: () => number
  tickIntervalMs?: number
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private readonly starting = new Set<string>()

  constructor(private readonly deps: TaskSchedulerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs ?? 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ---- CRUD (used by the RPC handlers and the agents' schedule tools) ----

  list(projectId?: string): TaskSchedule[] {
    return this.deps.repos.taskSchedules.list(projectId)
  }

  create(input: { projectId: string; name: string; instruction: string; when: When; missed?: 'run-late' | 'skip' }): TaskSchedule {
    this.deps.repos.projects.require(input.projectId)
    const problem = validateWhen(input.when)
    if (problem) throw new Error(`That schedule doesn't work: ${problem}`)
    if (!input.name.trim()) throw new Error('A scheduled task needs a name.')
    if (!input.instruction.trim()) throw new Error('A scheduled task needs an instruction to run.')
    const next = nextOccurrence(input.when, new Date(this.now()))
    if (!next) throw new Error(`${describeWhen(input.when)} is already in the past.`)
    const created = this.deps.repos.taskSchedules.create({ ...input, name: input.name.trim(), instruction: input.instruction.trim(), now: this.now() })
    return this.save(created.id, { nextRunAt: next.getTime() })
  }

  update(id: string, patch: { name?: string; instruction?: string; when?: When; enabled?: boolean; missed?: 'run-late' | 'skip' }): TaskSchedule {
    const current = this.deps.repos.taskSchedules.require(id)
    if (patch.when) {
      const problem = validateWhen(patch.when)
      if (problem) throw new Error(`That schedule doesn't work: ${problem}`)
    }
    const when = patch.when ?? current.when
    const enabled = patch.enabled ?? current.enabled
    const next = enabled ? nextOccurrence(when, new Date(this.now())) : null
    return this.save(id, { ...patch, nextRunAt: next ? next.getTime() : null, ...(enabled ? {} : { pendingSince: null }) })
  }

  async delete(id: string): Promise<void> {
    const schedule = this.deps.repos.taskSchedules.require(id)
    this.deps.repos.taskSchedules.delete(id)
    await this.deps.wake?.remove(wakeId(id)).catch(() => undefined)
    this.deps.bus.emit({ type: 'taskSchedule.deleted', scheduleId: id, projectId: schedule.projectId })
  }

  /** The user's own "Run now": allowed on every model, since it is the user asking. */
  async runNow(id: string): Promise<{ taskId: string }> {
    const schedule = this.deps.repos.taskSchedules.require(id)
    this.save(id, { pendingSince: null })
    return this.startRun(schedule)
  }

  /** The user tapped Start on a waiting run. Does nothing when nothing is waiting (a second tap). */
  async startPending(id: string): Promise<{ taskId: string } | null> {
    const schedule = this.deps.repos.taskSchedules.require(id)
    if (schedule.pendingSince === null || this.starting.has(id)) return null
    this.starting.add(id)
    try {
      this.save(id, { pendingSince: null })
      return await this.startRun(schedule)
    } finally {
      this.starting.delete(id)
    }
  }

  dismiss(id: string): TaskSchedule {
    return this.save(id, { pendingSince: null })
  }

  // ---- the clock ----

  async tick(now = this.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const schedule of this.deps.repos.taskSchedules.list()) {
        if (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now) continue
        const late = now - schedule.nextRunAt > MISSED_AFTER_MS
        const next = nextOccurrence(schedule.when, new Date(now))
        const project = this.deps.repos.projects.get(schedule.projectId)
        if (!project) continue
        const advance = { nextRunAt: next ? next.getTime() : null, ...(next ? {} : { enabled: false }) }

        if (late && schedule.missed === 'skip') {
          this.save(schedule.id, advance)
          continue
        }
        if (this.deps.isCliProject(project)) {
          // One waiting card at most: a card already waiting isn't stacked with another.
          const pendingSince = schedule.pendingSince ?? schedule.nextRunAt
          this.save(schedule.id, { ...advance, pendingSince })
          if (schedule.pendingSince === null) {
            this.deps.notify(
              `Ready to run: ${schedule.name}`,
              `${late ? 'Missed while the PC was off. ' : ''}It runs on ${project.name}'s command-line model, so it waits for you: open Deskmates and press Start.`
            )
          }
          continue
        }
        this.save(schedule.id, { ...advance, lastRunAt: now })
        await this.startRun(schedule, late).catch((error: unknown) => {
          this.deps.notify(`${schedule.name} didn't start`, error instanceof Error ? error.message : String(error))
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private async startRun(schedule: TaskSchedule, late = false): Promise<{ taskId: string }> {
    const { repos, bus } = this.deps
    // A run still going from last time isn't doubled up.
    if (schedule.lastTaskId && this.deps.isRunning(schedule.lastTaskId)) return { taskId: schedule.lastTaskId }
    const now = this.now()
    const date = new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    const task = repos.tasks.update(repos.tasks.create(schedule.projectId).id, { title: `${schedule.name} · ${date}` })
    bus.emit({ type: 'task.updated', task })
    this.save(schedule.id, { lastTaskId: task.id, lastRunAt: now })
    const text =
      `This is the scheduled task "${schedule.name}" (${describeWhen(schedule.when)}), started ${late ? 'late, because the PC was off at its time' : 'on time'}. ` +
      `The user isn't watching: do the work, and if something needs their yes, ask and wait. Finish with a short summary of what you did and found.\n\n${schedule.instruction}`
    await this.deps.send(task.id, text)
    void this.deps.whenIdle(task.id).then(() => {
      const finished = repos.tasks.get(task.id)
      if (!finished) return
      if (finished.status === 'waiting-approval') return // the runner already notified "Approval needed"
      this.deps.notify(
        finished.status === 'error' ? `${schedule.name} ran into a problem` : `${schedule.name} is done`,
        finished.status === 'error' ? (finished.error ?? 'Open the task to see what happened.') : 'Open the task in Deskmates to see the result.'
      )
    })
    return { taskId: task.id }
  }

  private save(id: string, patch: Parameters<Repos['taskSchedules']['update']>[1]): TaskSchedule {
    const schedule = this.deps.repos.taskSchedules.update(id, patch)
    this.deps.bus.emit({ type: 'taskSchedule.updated', schedule })
    if ('nextRunAt' in patch && this.deps.wake) {
      const wake = this.deps.wake
      const nextMs = schedule.enabled ? schedule.nextRunAt : null
      void (nextMs !== null ? wake.upsert(wakeId(id), nextMs) : wake.remove(wakeId(id))).catch((error: unknown) => {
        console.error('[schedules] wake timer failed', error instanceof Error ? error.message : error)
      })
    }
    return schedule
  }
}

const wakeId = (id: string): string => `task-${id}`
