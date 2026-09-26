/**
 * Ties the pieces in this folder together: cron parsing (`cron.ts`), the missed-run policy
 * (`catch-up.ts`) and Windows wake timers (`wake-timers.ts`) into the one thing `handlers.ts` and
 * `main.ts` need — a `ScheduleService` (`sync`/`unsync`, driven by the existing `schedules.*`
 * handlers, see `services.ts`) that also runs its own tick loop, starting due runs through the
 * injected `RunService` the same way `handlers.ts`'s `bots.run` does: create the `BotRun` row
 * under `<dataDir>/runs/`, emit `run.updated`, then fire-and-forget `run.start`.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Schedule } from '../../shared/protocol'
import type { CommandRunner } from '../bots/command-runner'
import type { RunService, ScheduleService } from '../bots/services'
import type { EventBus } from '../events'
import type { Repos } from '../store/repos'
import { DEFAULT_CATCH_UP_THRESHOLD_MS, planSchedule } from './catch-up'
import { nextRunAt, parseCron } from './cron'
import { WakeTimerManager } from './wake-timers'

export interface SchedulerDeps {
  repos: Repos
  bus: EventBus
  runner: CommandRunner
  /** Bot runs this schedule starts write to `<dataDir>/runs/<runId>/`, same as `bots.run`. */
  dataDir: string
  /** Starts a due run. Left unset, the ticker still advances schedules on time but starts nothing — lets the service be constructed before the run machinery exists. */
  run?: RunService
  now?: () => number
  /** How often to look for due schedules. Default 30 seconds. */
  tickIntervalMs?: number
  /** How late a run must be before it counts as missed (see `catch-up.ts`) rather than an on-time tick. Default 5 minutes. */
  catchUpThresholdMs?: number
  /** How many minutes before a run's due time its wake task should fire. Default 2, per the design spec (5.7). */
  wakeLeadMinutes?: number
}

/**
 * The scheduler task's one obvious constructor: `new Scheduler(deps)`, then `scheduler.start()`
 * once at boot. Implements `ScheduleService` directly, so `HandlerServices.schedule` can just be
 * the instance itself.
 */
export class Scheduler implements ScheduleService {
  private readonly deps: SchedulerDeps
  private readonly wakeTimers: WakeTimerManager
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: SchedulerDeps) {
    this.deps = deps
    this.wakeTimers = new WakeTimerManager({ runner: deps.runner, dataDir: deps.dataDir, leadMinutes: deps.wakeLeadMinutes })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ---- ScheduleService ----

  /** Validates and computes even for a disabled schedule (so a bad cron is caught immediately), but only a schedule that's both enabled and reachable gets a wake timer — see the class doc for what "unreachable" means. */
  async sync(schedule: Schedule): Promise<{ nextRunAt: number | null }> {
    const cron = parseCron(schedule.cron)
    if (!schedule.enabled) {
      await this.removeWakeTimer(schedule.id)
      return { nextRunAt: null }
    }
    const next = nextRunAt(cron, new Date(this.now()))
    const nextMs = next ? next.getTime() : null
    await this.syncWakeTimer(schedule.id, schedule.botId, nextMs)
    return { nextRunAt: nextMs }
  }

  /** Unregisters the wake timer before a schedule is deleted. Unlike `sync`, a genuine failure here propagates — same as `pcs.delete` in `handlers.ts`, cleanup failures are surfaced rather than silently leaving something orphaned. */
  async unsync(scheduleId: string): Promise<void> {
    await this.wakeTimers.remove(scheduleId)
  }

  // ---- tick loop ----

  /** Starts the periodic tick, running one immediately so anything missed while the app wasn't running is caught up right away. Safe to call more than once. */
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

  /**
   * One pass over every enabled schedule: starts what's due (honouring each one's catch-up
   * policy), advances it to its next occurrence, and re-registers its wake timer. Exposed
   * directly (not just through `start`'s interval) so tests can drive it deterministically with a
   * fake clock instead of a real timer.
   */
  async tick(now = this.now()): Promise<void> {
    for (const schedule of this.deps.repos.schedules.list()) {
      if (!schedule.enabled) continue
      const plan = planSchedule(schedule, now, this.deps.catchUpThresholdMs ?? DEFAULT_CATCH_UP_THRESHOLD_MS)
      if (plan.action === 'none') continue

      if (plan.action === 'run') await this.startRun(schedule)

      const next = nextRunAt(parseCron(schedule.cron), new Date(now))
      const nextMs = next ? next.getTime() : null
      const updated = this.deps.repos.schedules.update(schedule.id, {
        nextRunAt: nextMs,
        lastRunAt: plan.action === 'run' ? now : schedule.lastRunAt
      })
      this.deps.bus.emit({ type: 'schedule.updated', schedule: updated })
      await this.syncWakeTimer(schedule.id, schedule.botId, nextMs)
    }
  }

  private async startRun(schedule: Schedule): Promise<void> {
    const bot = this.deps.repos.bots.get(schedule.botId)
    if (!bot) return // an orphaned schedule shouldn't happen (bots.delete cascades schedules), but a run needs a bot to run as.
    const id = randomUUID()
    const run = this.deps.repos.runs.create(bot.id, schedule.task, join(this.deps.dataDir, 'runs', id), schedule.id, id)
    this.deps.bus.emit({ type: 'run.updated', run })
    if (this.deps.run) void this.deps.run.start(run, bot).catch(() => {})
  }

  private async syncWakeTimer(scheduleId: string, botId: string, nextMs: number | null): Promise<void> {
    if (nextMs != null) await this.upsertWakeTimer(scheduleId, botId, nextMs)
    else await this.removeWakeTimer(scheduleId)
  }

  /** A wake-timer failure never blocks `sync`/`tick` (see `wake-timers.ts`'s doc comment) — it only means a sleeping PC won't wake for this run. Logged, not thrown. */
  private async upsertWakeTimer(scheduleId: string, botId: string, nextMs: number): Promise<void> {
    try {
      await this.wakeTimers.upsert(scheduleId, botId, nextMs)
    } catch (error) {
      this.reportWakeTimerFailure(scheduleId, error)
    }
  }

  private async removeWakeTimer(scheduleId: string): Promise<void> {
    try {
      await this.wakeTimers.remove(scheduleId)
    } catch (error) {
      this.reportWakeTimerFailure(scheduleId, error)
    }
  }

  private reportWakeTimerFailure(scheduleId: string, error: unknown): void {
    console.error(`[scheduler] wake timer failed for schedule ${scheduleId}:`, error instanceof Error ? error.message : error)
  }
}
